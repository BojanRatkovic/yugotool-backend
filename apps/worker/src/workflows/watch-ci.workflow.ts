// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import type { CiState } from "@zastava/contracts";
import { ParentClosePolicy, proxyActivities, sleep, startChild } from "@temporalio/workflow";
import type { Activities } from "../activities";
import { CI_POLL_MS, type CiMode, ciSummary, evaluateCi, isSettled } from "./ci-logic";

/** Reads gh and writes bookkeeping: idempotent, so retried. */
const ci = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5 },
});

export interface WatchCiInput {
  workOrderId: string;
  mode: CiMode;
}

/**
 * Watches a work order's PR until its CI settles (spec 0006 §3) and records
 * each poll. One per work order: workflow id `ci-<workOrderId>`.
 */
export async function watchCi(input: WatchCiInput): Promise<CiState | null> {
  let elapsedMs = 0;
  let settledPolls = 0;
  let sawPending = false;
  for (let first = true; ; first = false) {
    const poll = await ci.pollCi({ workOrderId: input.workOrderId });
    if (!poll) return null;
    if (isSettled(poll.checks)) settledPolls += 1;
    else {
      settledPolls = 0;
      if (poll.checks.length > 0) sawPending = true;
    }
    const state = evaluateCi(poll.checks, {
      mode: input.mode,
      elapsedMs,
      settledPolls,
      sawPending,
    });
    await ci.recordCi({
      workOrderId: input.workOrderId,
      mode: input.mode,
      first,
      state,
      summary: ciSummary(state, poll.checks),
      poll,
    });
    // A merged or closed PR gets no new checks.
    if (state !== "pending" || poll.prState !== "open") return state;
    await sleep(CI_POLL_MS);
    elapsedMs += CI_POLL_MS;
  }
}

/**
 * Starts the CI watch after delivery, detached: the run is done, CI is
 * information. Never throws — a watch that cannot start must not fail the run.
 */
export async function startCiWatch(workOrderId: string): Promise<void> {
  try {
    await startChild(watchCi, {
      workflowId: `ci-${workOrderId}`,
      args: [{ workOrderId, mode: "delivery" }],
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
  } catch {
    // Usually a watch for this work order is already running (a refresh): it
    // carries on. "Re-check" in the UI starts one otherwise.
  }
}
