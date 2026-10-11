import type { CiStatus } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { ciRefreshMode } from "../src/modules/work-orders/ci-refresh";

const ci = (startedAt: string): CiStatus => ({
  state: "no_ci",
  summary: "No CI reported on this PR",
  prState: "open",
  headSha: "bd6ce48",
  deliveredSha: "bd6ce48",
  checks: [],
  startedAt,
  checkedAt: startedAt,
  finishedAt: startedAt,
});

describe("ciRefreshMode", () => {
  const delivered = new Date("2026-10-11T19:27:02Z");

  it("treats a refresh before any watch as the delivery watch", () => {
    // The panel opened 2 s after the push and called it "no CI" at once.
    expect(ciRefreshMode(null, delivered)).toBe("delivery");
    expect(ciRefreshMode(null, null)).toBe("delivery");
  });

  it("treats a refresh after a newer delivery as the delivery watch", () => {
    expect(ciRefreshMode(ci("2026-10-11T18:00:00Z"), delivered)).toBe("delivery");
  });

  it("is a plain refresh once a watch has looked at the latest delivery", () => {
    expect(ciRefreshMode(ci("2026-10-11T19:27:09Z"), delivered)).toBe("refresh");
    expect(ciRefreshMode(ci("2026-10-11T19:27:09Z"), null)).toBe("refresh");
  });
});
