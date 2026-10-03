// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "../activities";

const work = proxyActivities<Activities>({
  // A first clone of a big remote can take minutes.
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 1 },
});

/** "Sync now" on a knowledge source, and the check after it is added or edited. */
export async function syncKnowledge(input: {
  sourceId: string;
}): Promise<{ error: string | null }> {
  return work.syncKnowledge(input);
}
