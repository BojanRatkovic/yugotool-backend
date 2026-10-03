import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Client } from "@temporalio/client";
import {
  type PostFindings,
  type StartReview,
  TASK_QUEUE,
  type ZastavaReview,
  type ZastavaReviewBrief,
} from "@zastava/contracts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import { ProjectsService } from "../projects/projects.service";
import { type ReviewRow, PullRequestReviewsRepository } from "./pull-request-reviews.repository";
import { PullRequestWritesService } from "./pull-request-writes.service";
import {
  FindingUnknownError,
  GithubRefusedError,
  PullRequestNotOpenError,
  ReviewAlreadyRunningError,
  ReviewNotReadyError,
  ReviewStaleError,
} from "./pull-requests.errors";
import { planPendingReview } from "./review-findings";
import { PullRequestsService } from "./pull-requests.service";

/** Workflow type name registered by the worker. */
const REVIEW_RUN_WORKFLOW = "reviewRun";
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

function toReview(row: ReviewRow, head?: string): ZastavaReview {
  return {
    workOrderId: row.workOrderId,
    runId: row.runId,
    // A run row exists from the start; null only if its insert raced a read.
    status: row.runStatus ?? "running",
    costUsd: row.costUsd,
    pullRequest: row.pullRequest,
    stale: head !== undefined && head !== row.pullRequest.headOid,
    verdict: row.verdict,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** ZASTAVA reviews of pull requests (spec 0009): start one, read the latest. */
@Injectable()
export class PullRequestReviewsService {
  private readonly logger = new Logger(PullRequestReviewsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PullRequestReviewsRepository,
    private readonly pullRequests: PullRequestsService,
    private readonly writes: PullRequestWritesService,
    private readonly projects: ProjectsService,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  briefs(projectId: string): Promise<ZastavaReviewBrief[]> {
    return this.repository.briefs(this.database.db, projectId);
  }

  /** The newest review of the PR; `head` (the PR's current head) marks it stale. */
  async latest(projectId: string, number: number, head?: string): Promise<ZastavaReview | null> {
    const row = await this.repository.latest(this.database.db, projectId, number);
    return row ? toReview(row, head) : null;
  }

  /**
   * Freezes the PR's current head and starts the project's review line on it.
   * Idempotent on the client's id; 409 while another review of the PR runs.
   */
  async start(projectId: string, number: number, input: StartReview): Promise<ZastavaReview> {
    const db = this.database.db;
    if (input.id && (await this.repository.exists(db, input.id))) {
      const existing = await this.repository.find(db, input.id);
      if (existing) return toReview(existing);
    }
    if (await this.repository.isRunning(db, projectId, number)) {
      throw new ReviewAlreadyRunningError(`a ZASTAVA review of #${number} is already running`);
    }
    const pr = await this.pullRequests.reviewSnapshot(projectId, number);
    if (!pr.open) throw new PullRequestNotOpenError(`pull request #${number} is not open`);
    // Seeds the review line on a project's first review.
    await this.projects.getReviewLine(projectId);

    const created = await this.database.transaction(async (tx) => {
      if (await this.repository.isRunning(tx, projectId, number)) {
        throw new ReviewAlreadyRunningError(`a ZASTAVA review of #${number} is already running`);
      }
      const lastHead = await this.repository.lastReviewedHead(tx, projectId, number);
      return this.repository.insertRunning(tx, {
        id: input.id,
        projectId,
        title: `Review #${pr.number}: ${pr.title}`.slice(0, MAX_TITLE),
        description: pr.body.slice(0, MAX_DESCRIPTION),
        pullRequest: {
          number: pr.number,
          url: pr.url,
          headRefName: pr.headRefName,
          headOid: pr.headOid,
          baseRefName: pr.baseRefName,
          baseOid: pr.baseOid,
          // Same head again = a fresh full review, not an empty re-review.
          sinceOid: lastHead && lastHead !== pr.headOid ? lastHead : null,
          openThreads: pr.openThreads,
          posted: [],
        },
      });
    });

    try {
      await this.temporal.workflow.start(REVIEW_RUN_WORKFLOW, {
        taskQueue: TASK_QUEUE,
        workflowId: created.workflowId,
        args: [{ runId: created.runId, workOrderId: created.workOrderId }],
      });
    } catch (error) {
      this.logger.error(
        `failed to start review workflow for run ${created.runId}`,
        error instanceof Error ? error.stack : error,
      );
      await this.repository.markFailed(db, created.workOrderId, created.runId);
      await this.notify();
      throw error;
    }
    await this.notify();
    const row = await this.repository.find(db, created.workOrderId);
    if (!row) throw new Error("review work order vanished after insert");
    return toReview(row);
  }

  /**
   * The findings the human kept (as edited) go into their pending review on
   * GitHub; nothing is submitted. What got in is remembered per finding, also
   * when GitHub refuses one halfway (then 422 with GitHub's message).
   */
  async post(projectId: string, number: number, input: PostFindings): Promise<ZastavaReview> {
    const db = this.database.db;
    const row = await this.repository.latest(db, projectId, number);
    if (!row?.verdict || row.runStatus !== "succeeded") {
      throw new ReviewNotReadyError(`#${number} has no finished ZASTAVA review`);
    }
    const { plan, unknown } = planPendingReview(row.verdict.findings, input.findings);
    if (unknown.length > 0) {
      throw new FindingUnknownError(`the review has no finding ${unknown.join(", ")}`);
    }
    const head = row.pullRequest.headOid;
    const result = await this.writes.addToPendingReview(
      projectId,
      number,
      { comments: plan.comments, body: plan.body, expectHead: head },
      (moved) =>
        new ReviewStaleError(
          `#${number} moved to ${moved.slice(0, 7)} after the review of ${head.slice(0, 7)}; run the review again`,
        ),
    );
    const posted = [
      ...(result.bodyAdded ? plan.bodyIds : []),
      ...result.added.map((i) => plan.commentIds[i]).filter((id) => id !== undefined),
    ];
    if (posted.length > 0) {
      await this.repository.markPosted(db, row.workOrderId, posted);
      await this.events.publish({ type: "invalidate", collection: "reviews" });
    }
    if (result.refused) {
      throw new GithubRefusedError(
        `${posted.length} of ${input.findings.length} added; GitHub refused the next one: ${result.refused}`,
      );
    }
    const updated = await this.repository.find(db, row.workOrderId);
    if (!updated) throw new Error("review work order vanished");
    return toReview(updated, head);
  }

  private async notify(): Promise<void> {
    await this.events.publish({ type: "invalidate", collection: "reviews" });
    await this.events.publish({ type: "invalidate", collection: "runs" });
  }
}
