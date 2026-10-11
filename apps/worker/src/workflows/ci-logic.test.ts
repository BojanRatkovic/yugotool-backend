import type { CiCheck } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import {
  CI_MIN_WAIT_MS,
  CI_NO_CHECKS_MS,
  CI_TIMEOUT_MS,
  type CiWatch,
  ciSummary,
  evaluateCi,
} from "./ci-logic";

const check = (bucket: CiCheck["bucket"], name = bucket): CiCheck => ({
  name,
  workflow: null,
  bucket,
  link: null,
  startedAt: null,
  completedAt: null,
});

const delivery = (patch: Partial<CiWatch> = {}): CiWatch => ({
  mode: "delivery",
  elapsedMs: CI_MIN_WAIT_MS,
  settledPolls: 2,
  sawPending: true,
  ...patch,
});

describe("evaluateCi", () => {
  it("waits for checks to register, then calls it no CI", () => {
    expect(evaluateCi([], delivery({ elapsedMs: 0, settledPolls: 0 }))).toBe("pending");
    expect(evaluateCi([], delivery({ elapsedMs: CI_NO_CHECKS_MS, settledPolls: 0 }))).toBe("no_ci");
  });

  it("keeps watching while anything is pending, up to the timeout", () => {
    const checks = [check("pass"), check("pending")];
    expect(evaluateCi(checks, delivery({ settledPolls: 0 }))).toBe("pending");
    expect(evaluateCi(checks, delivery({ settledPolls: 0, elapsedMs: CI_TIMEOUT_MS }))).toBe(
      "timed_out",
    );
  });

  it("after a push, believes 'done' only after two settled polls and the minimum wait", () => {
    const checks = [check("pass")];
    expect(evaluateCi(checks, delivery({ settledPolls: 1 }))).toBe("pending");
    expect(evaluateCi(checks, delivery({ elapsedMs: CI_MIN_WAIT_MS - 1 }))).toBe("pending");
    expect(evaluateCi(checks, delivery())).toBe("passed");
  });

  it("fails on any failed or cancelled check, ignoring skipped ones", () => {
    expect(evaluateCi([check("pass"), check("skipping"), check("fail")], delivery())).toBe(
      "failed",
    );
    expect(evaluateCi([check("cancel")], delivery())).toBe("failed");
    expect(evaluateCi([check("pass"), check("skipping")], delivery())).toBe("passed");
    expect(evaluateCi([check("skipping")], delivery())).toBe("no_ci");
  });

  it("a refresh that finds everything done believes it at once", () => {
    const refresh: CiWatch = { mode: "refresh", elapsedMs: 0, settledPolls: 1, sawPending: false };
    expect(evaluateCi([check("fail")], refresh)).toBe("failed");
    expect(evaluateCi([], refresh)).toBe("no_ci");
  });

  it("a refresh that saw a rerun start waits for two settled polls", () => {
    const refresh: CiWatch = {
      mode: "refresh",
      elapsedMs: 30_000,
      settledPolls: 1,
      sawPending: true,
    };
    expect(evaluateCi([check("pass")], refresh)).toBe("pending");
    expect(evaluateCi([check("pass")], { ...refresh, settledPolls: 2 })).toBe("passed");
  });
});

describe("ciSummary", () => {
  it("counts what matters per state", () => {
    expect(
      ciSummary("failed", [check("fail"), check("pass"), check("pass"), check("skipping")]),
    ).toBe("1 failed · 2 passed · 1 skipped");
    expect(ciSummary("passed", [check("pass")])).toBe("1 passed");
    expect(ciSummary("pending", [check("pass"), check("pending")])).toBe("Running · 1/2 done");
    expect(ciSummary("pending", [])).toBe("Waiting for CI to report");
    expect(ciSummary("no_ci", [])).toBe("No CI reported on this PR");
    expect(ciSummary("timed_out", [check("pending")])).toBe(
      "Still running after 90 min · 1 pending",
    );
  });
});
