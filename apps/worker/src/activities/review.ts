import { ApplicationFailure } from "@temporalio/activity";
import {
  type Effort,
  type ReviewFinding,
  type ReviewVerdict,
  type Station,
  reviewPullRequestSchema,
} from "@yugotool/contracts";
import { type Database, lines, projects, runs, stationRuns, workOrders } from "@yugotool/db";
import { and, eq } from "drizzle-orm";
import { localRunner } from "../runner/local-runner";
import {
  ReviewHeadMissingError,
  buildReviewBrief,
  changedFiles,
  fetchPullRequest,
  mergeBase,
  pullRequestPatch,
  writeReviewBrief,
} from "../runner/review-workspace";
import { anchorFindings, parseHunks } from "../runner/diff-anchors";
import { mergeFindings, reconcilePrevious } from "../workflows/review-logic";
import type { ShiftDeps } from "./shifts";

type ReviewDeps = Pick<ShiftDeps, "appendEvent" | "invalidateBoard" | "notify" | "notifyHumans">;

/** What the reviewRun workflow needs, set up by prepareReview. */
export interface ReviewRunContext {
  stations: Station[];
  worktreePath: string;
  title: string;
  description: string;
  /** `previousFindings`: how many the reviewer must give a status (spec 0010). */
  pullRequest: { number: number; url: string; previousFindings?: number };
  /** The PR's base branch (QA compares against it). */
  baseBranch: string;
  modelOverride: string | null;
  effortOverride: Effort | null;
  maxBudgetUsd: number | null;
}

export function createReviewActivities(db: Database, deps: ReviewDeps) {
  return {
    /**
     * Fetches the PR's head, adds a detached worktree on it and writes the
     * review brief. A head that is gone from GitHub fails the run for good.
     */
    async prepareReview(input: { runId: string; workOrderId: string }): Promise<ReviewRunContext> {
      const [row] = await db
        .select({ workOrder: workOrders, project: projects, line: lines })
        .from(workOrders)
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .innerJoin(lines, and(eq(lines.projectId, projects.id), eq(lines.kind, "review")))
        .where(eq(workOrders.id, input.workOrderId));
      if (!row) {
        throw ApplicationFailure.nonRetryable(
          `review work order ${input.workOrderId} or its review line not found`,
        );
      }
      if (!row.workOrder.pullRequest) {
        throw ApplicationFailure.nonRetryable("This work order has no pull request to review");
      }
      // Fills the fields newer than the row (spec 0010).
      const pr = reviewPullRequestSchema.parse(row.workOrder.pullRequest);
      const repoPath = row.project.repoPath;
      try {
        await fetchPullRequest(repoPath, pr);
      } catch (error) {
        if (error instanceof ReviewHeadMissingError) {
          throw ApplicationFailure.nonRetryable(error.message);
        }
        throw error;
      }
      const worktreePath = await localRunner.addDetachedWorktree(repoPath, pr.headOid, input.runId);
      await db.update(runs).set({ worktreePath }).where(eq(runs.id, input.runId));

      const base = await mergeBase(worktreePath, pr.baseOid, pr.headOid);
      const files = await changedFiles(worktreePath, base, pr.headOid);
      const sinceFiles = pr.sinceOid
        ? await changedFiles(worktreePath, pr.sinceOid, pr.headOid).catch(() => null)
        : null;
      await writeReviewBrief(
        worktreePath,
        buildReviewBrief({
          title: row.workOrder.title,
          body: row.workOrder.description,
          pr,
          mergeBaseOid: base,
          files,
          sinceFiles,
        }),
      );
      await deps.appendEvent(
        input.runId,
        null,
        "system",
        `Reviewing PR #${pr.number} at ${pr.headOid.slice(0, 7)} (${files.length} file${files.length === 1 ? "" : "s"}${sinceFiles ? `, ${sinceFiles.length} since the last review` : ""})`,
      );
      await deps.invalidateBoard();
      return {
        stations: row.line.stations,
        worktreePath,
        title: row.workOrder.title,
        description: row.workOrder.description,
        pullRequest: {
          number: pr.number,
          url: pr.url,
          previousFindings: pr.previousFindings.length,
        },
        baseBranch: pr.baseRefName,
        modelOverride: row.workOrder.modelOverride,
        effortOverride: row.workOrder.effortOverride,
        maxBudgetUsd: row.workOrder.maxBudgetUsd,
      };
    },

    /**
     * Folds what checks and QA found into the reviewer's verdict (stored on
     * the review station's row) and tells the human the review is ready.
     */
    async completeReview(input: {
      runId: string;
      workOrderId: string;
      stationRunId: string;
      extra: ReviewFinding[];
    }): Promise<ReviewVerdict> {
      const [row] = await db
        .select({
          review: stationRuns.review,
          worktreePath: runs.worktreePath,
          pullRequest: workOrders.pullRequest,
        })
        .from(stationRuns)
        .innerJoin(runs, eq(runs.id, stationRuns.runId))
        .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
        .where(eq(stationRuns.id, input.stationRunId));
      if (!row?.review) throw ApplicationFailure.nonRetryable("The reviewer returned no review");
      const previous = row.pullRequest?.previousFindings ?? [];
      const merged = reconcilePrevious(mergeFindings(row.review, input.extra), previous);
      // GitHub refuses line comments outside the PR diff's hunks.
      let review = merged;
      if (row.worktreePath && row.pullRequest) {
        const { baseOid, headOid } = row.pullRequest;
        const base = await mergeBase(row.worktreePath, baseOid, headOid);
        const hunks = parseHunks(await pullRequestPatch(row.worktreePath, base, headOid));
        review = { ...merged, findings: anchorFindings(merged.findings, hunks) };
        const moved = review.findings.filter(
          (f, i) => f.line === null && merged.findings[i]?.line !== null,
        ).length;
        if (moved > 0) {
          await deps.appendEvent(
            input.runId,
            input.stationRunId,
            "system",
            `${moved} finding${moved === 1 ? "" : "s"} pointed outside the PR diff; they go to the review body instead of a line.`,
          );
        }
      }
      await db.update(stationRuns).set({ review }).where(eq(stationRuns.id, input.stationRunId));
      await deps.notify({ type: "invalidate", collection: "reviews" });
      const count = review.findings.length;
      await deps.notifyHumans(
        { kind: "review_ready", payload: { workOrderId: input.workOrderId, findings: count } },
        `review_ready:${input.stationRunId}`,
      );
      return review;
    },

    /** A review leaves nothing behind: no branch, no snapshot commit. */
    async removeReviewWorkspace(input: { runId: string }): Promise<void> {
      const [row] = await db
        .select({ worktreePath: runs.worktreePath, repoPath: projects.repoPath })
        .from(runs)
        .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .where(eq(runs.id, input.runId));
      if (!row?.worktreePath) return;
      await localRunner.removeWorktree(row.repoPath, row.worktreePath);
    },
  };
}
