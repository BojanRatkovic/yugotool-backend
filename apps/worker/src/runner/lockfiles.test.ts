import { describe, expect, it } from "vitest";
import { incidentalLockfiles } from "./local-runner";

describe("incidentalLockfiles", () => {
  it("flags lockfiles changed without any package.json", () => {
    expect(
      incidentalLockfiles(["package-lock.json", "src/a.tsx", "apps/web/pnpm-lock.yaml"]),
    ).toEqual(["package-lock.json", "apps/web/pnpm-lock.yaml"]);
  });

  it("keeps them when a dependency change explains them", () => {
    expect(incidentalLockfiles(["package-lock.json", "packages/ui/package.json"])).toEqual([]);
    expect(incidentalLockfiles(["src/a.tsx"])).toEqual([]);
  });
});
