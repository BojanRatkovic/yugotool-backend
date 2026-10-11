// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import type { PreviewSignIn } from "@yugotool/contracts";
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";

const work = proxyActivities<Activities>({
  // Install + start, then up to 15 minutes for the user to sign in.
  startToCloseTimeout: "40 minutes",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 1 },
});

/** Project settings → Preview → "Sign in": save a browser session for the preview. */
export async function previewSignIn(input: { projectId: string }): Promise<PreviewSignIn> {
  return work.previewSignIn(input);
}
