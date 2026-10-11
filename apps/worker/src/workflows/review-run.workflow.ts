// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import type { KnowledgeMount, ReviewFinding } from "@yugotool/contracts";
import { CancellationScope, isCancellation, proxyActivities } from "@temporalio/workflow";
import type { Activities, AgentStationResult, QaResult } from "../activities";
import type { StationNote } from "./line-logic";
import { buildReviewPrompt, checksFinding, qaFinding } from "./review-logic";

/** Bookkeeping writes: short and retried hard — losing one desyncs the UI. */
const bookkeeping = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

/** Fetching a PR and adding a worktree: git over the network, safe to retry. */
const setup = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },
});

/** Agent sessions, checks and QA cost money and are never retried automatically. */
const work = proxyActivities<Activities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "3 minutes",
  retry: { maximumAttempts: 1 },
});

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

export interface ReviewRunInput {
  runId: string;
  workOrderId: string;
}

/**
 * Reviews a pull request (spec 0009): the project's review line on a detached
 * worktree at the PR's head. No loop-backs and no gates: a failing check or QA
 * becomes a finding, and the human triages the findings in the PR panel.
 */
export async function reviewRun(input: ReviewRunInput): Promise<void> {
  const finish = (status: "succeeded" | "failed" | "cancelled", reason?: string) =>
    CancellationScope.nonCancellable(async () => {
      await bookkeeping.finishRun({ ...input, status, ...(reason ? { reason } : {}) });
      await setup.removeReviewWorkspace({ runId: input.runId });
    });

  try {
    const run = await setup.prepareReview(input);
    const readsKnowledge = (station: (typeof run.stations)[number]): boolean =>
      station.kind === "agent" && station.useKnowledge === true && !station.canEdit;
    const knowledge: KnowledgeMount[] = run.stations.some(readsKnowledge)
      ? await setup.prepareKnowledge(input)
      : [];
    const notes: StationNote[] = [];
    const extra: ReviewFinding[] = [];
    let reviewStationRunId: string | null = null;
    let spentUsd = 0;

    for (const station of run.stations) {
      if (station.kind === "gate" || station.kind === "shift") continue;
      if (run.maxBudgetUsd !== null && spentUsd >= run.maxBudgetUsd) {
        await finish(
          "failed",
          `Budget exhausted: $${spentUsd.toFixed(2)} of $${run.maxBudgetUsd.toFixed(2)} spent before ${station.name}`,
        );
        return;
      }
      const stationRunId = await bookkeeping.beginStation({
        ...input,
        stationKey: station.key,
        attempt: 1,
        status: "running",
      });

      if (station.kind === "checks") {
        const result = await work.runChecks({
          runId: input.runId,
          stationRunId,
          station,
          worktreePath: run.worktreePath,
        });
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: result.passed ? "succeeded" : "failed",
          output: result.output,
        });
        if (!result.passed) extra.push(checksFinding(station, result.output, extra.length + 1));
        notes.push({
          station: station.name,
          text: `\`${station.command}\` ${result.passed ? "passed" : `failed:\n${result.output}`}`,
        });
        continue;
      }

      if (station.kind === "qa") {
        const result: QaResult = await work.runQaStation({
          runId: input.runId,
          stationRunId,
          station,
          worktreePath: run.worktreePath,
          baseBranch: run.baseBranch,
          attempt: 1,
          title: run.title,
          description: run.description,
          modelOverride: run.modelOverride,
          effortOverride: run.effortOverride,
          previousReport: null,
        });
        spentUsd += result.costUsd;
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: result.status === "passed" ? "succeeded" : "failed",
          output: result.summary,
        });
        if (result.status !== "passed") {
          const qa = { status: result.status, summary: result.summary, report: result.report };
          extra.push(qaFinding(station.name, qa, extra.length + 1));
        }
        notes.push({ station: station.name, text: result.summary });
        continue;
      }

      const result: AgentStationResult = await work.runAgentStation({
        runId: input.runId,
        stationRunId,
        station,
        worktreePath: run.worktreePath,
        prompt: buildReviewPrompt(run, station, notes, readsKnowledge(station) ? knowledge : []),
        modelOverride: run.modelOverride,
        effortOverride: run.effortOverride,
        resumeSessionId: null,
        ...(readsKnowledge(station) && knowledge.length > 0 ? { knowledge } : {}),
      });
      spentUsd += result.costUsd;
      const noReview = station.structuredVerdict === "review" && !result.review;
      await bookkeeping.finishStation({
        runId: input.runId,
        stationRunId,
        status: result.isError || noReview ? "failed" : "succeeded",
        output: result.output,
      });
      if (result.isError || noReview) {
        await finish(
          "failed",
          result.isError
            ? `${station.name} failed: ${result.output}`
            : `${station.name} returned no structured review`,
        );
        return;
      }
      if (station.structuredVerdict === "review") reviewStationRunId = stationRunId;
      notes.push({ station: station.name, text: result.output });
    }

    if (!reviewStationRunId) {
      await finish("failed", "The review line has no reviewer station (structured review)");
      return;
    }
    await bookkeeping.completeReview({ ...input, stationRunId: reviewStationRunId, extra });
    await finish("succeeded");
  } catch (error) {
    if (isCancellation(error)) {
      await finish("cancelled", "Cancelled by user");
      throw error;
    }
    await finish("failed", describeFailure(error));
    throw error;
  }
}
