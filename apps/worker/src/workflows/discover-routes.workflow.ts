// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";

const work = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "1 minute",
  // An agent session: never auto-retried (cost).
  retry: { maximumAttempts: 1 },
});

/** Project settings → "Discover routes": map the app's screens for QA's planner. */
export async function discoverRoutes(input: {
  projectId: string;
}): Promise<{ ok: boolean; error: string | null }> {
  return work.discoverRoutes(input);
}
