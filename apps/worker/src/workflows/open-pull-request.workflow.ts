// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";

const work = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  // Pushes and opens a PR: never retried blindly.
  retry: { maximumAttempts: 1 },
});

/** "Open pull request" on work delivered locally. */
export async function openPullRequest(input: {
  workOrderId: string;
  draft: boolean;
}): Promise<{ prUrl: string | null; error: string | null }> {
  return work.openPullRequest(input);
}
