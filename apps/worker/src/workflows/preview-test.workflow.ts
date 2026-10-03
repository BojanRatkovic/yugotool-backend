// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import type { PreviewTestResult } from "@zastava/contracts";
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";

const work = proxyActivities<Activities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

/** Project settings → "Test preview": boot the app once on the base branch. */
export async function previewTest(input: { projectId: string }): Promise<PreviewTestResult> {
  return work.previewTest(input);
}
