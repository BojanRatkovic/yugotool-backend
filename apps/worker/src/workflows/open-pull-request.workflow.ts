// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import { patched, proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";
import { startCiWatch } from "./watch-ci.workflow";

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
  const result = await work.openPullRequest(input);
  if (result.prUrl && patched("ci-watch")) await startCiWatch(input.workOrderId);
  return result;
}
