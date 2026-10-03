// Pure helpers for the CI watch — deterministic, no I/O.
import type { CiCheck, CiState } from "@zastava/contracts";

export const CI_POLL_MS = 30_000;
/** No check registered by then: the repo has no CI for this PR. */
export const CI_NO_CHECKS_MS = 5 * 60_000;
/** Delivery only: statuses (Semaphore) can register minutes after Actions finished. */
export const CI_MIN_WAIT_MS = 3 * 60_000;
export const CI_TIMEOUT_MS = 90 * 60_000;
/** Consecutive polls with nothing pending before "done" is believed. */
export const CI_SETTLED_POLLS = 2;

/** delivery: the watch right after ZASTAVA pushed. refresh: someone asked to look again. */
export type CiMode = "delivery" | "refresh";

export interface CiWatch {
  mode: CiMode;
  /** Since the watch started (polls × interval). */
  elapsedMs: number;
  /** Consecutive polls, this one included, with checks and none pending. */
  settledPolls: number;
  /** A poll of this watch saw a pending check. */
  sawPending: boolean;
}

/** Whether a poll counts towards "settled": checks exist and none is pending. */
export function isSettled(checks: CiCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.bucket !== "pending");
}

/** This poll's verdict; "pending" keeps the watch going (spec 0006 §3). */
export function evaluateCi(checks: CiCheck[], watch: CiWatch): CiState {
  if (checks.length === 0) {
    if (watch.mode === "refresh" || watch.elapsedMs >= CI_NO_CHECKS_MS) return "no_ci";
    return "pending";
  }
  if (!isSettled(checks)) return watch.elapsedMs >= CI_TIMEOUT_MS ? "timed_out" : "pending";
  // A refresh that finds everything done believes it at once; a fresh push or a
  // rerun it watched start waits for late statuses.
  const needsConfirming = watch.mode === "delivery" || watch.sawPending;
  if (needsConfirming) {
    const waited = watch.mode === "refresh" || watch.elapsedMs >= CI_MIN_WAIT_MS;
    if (watch.settledPolls < CI_SETTLED_POLLS || !waited) return "pending";
  }
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failed";
  if (checks.every((c) => c.bucket === "skipping")) return "no_ci";
  return "passed";
}

const joinCounts = (list: [number, string][]): string =>
  list
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");

/** One line for the station card and Activity, e.g. "1 failed · 3 passed · 2 skipped". */
export function ciSummary(state: CiState, checks: CiCheck[]): string {
  const count = (bucket: CiCheck["bucket"]): number =>
    checks.filter((c) => c.bucket === bucket).length;
  const passed: [number, string] = [count("pass"), "passed"];
  const skipped: [number, string] = [count("skipping"), "skipped"];
  const pending = count("pending");
  if (state === "pending") {
    return checks.length === 0
      ? "Waiting for CI to report"
      : `Running · ${checks.length - pending}/${checks.length} done`;
  }
  if (state === "passed") return joinCounts([passed, skipped]);
  if (state === "failed") {
    return joinCounts([[count("fail") + count("cancel"), "failed"], passed, skipped]);
  }
  if (state === "no_ci") {
    return checks.length === 0 ? "No CI reported on this PR" : "Every check was skipped";
  }
  return `Still running after ${CI_TIMEOUT_MS / 60_000} min · ${pending} pending`;
}
