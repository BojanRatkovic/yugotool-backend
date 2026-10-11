import type { CiStatus } from "@yugotool/contracts";

/** The watch modes the worker's `watchCi` takes. */
export type CiWatchMode = "delivery" | "refresh";

/**
 * How a refresh watches CI. Until a watch has looked at the latest delivery,
 * a refresh (the panel opening right after the push) gets the delivery rules:
 * checks need minutes to register, so "none yet" is not "no CI".
 */
export function ciRefreshMode(ci: CiStatus | null, deliveredAt: Date | null): CiWatchMode {
  if (ci === null) return "delivery";
  if (deliveredAt && new Date(ci.startedAt).getTime() < deliveredAt.getTime()) return "delivery";
  return "refresh";
}
