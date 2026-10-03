import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNoChecksError, parseChecks } from "./ci-checks";

// Real `gh pr checks --json …` output (storefront#1179): Actions jobs
// plus Semaphore's commit status, which has no workflow and year-1 times.
const MIXED = readFileSync(path.join(__dirname, "fixtures", "gh-pr-checks-mixed.json"), "utf8");

describe("parseChecks", () => {
  it("reads Actions check runs and Semaphore commit statuses alike", () => {
    const checks = parseChecks(MIXED);
    expect(checks.map((c) => c.bucket)).toEqual([
      "skipping",
      "skipping",
      "skipping",
      "pass",
      "fail",
    ]);
    const semaphore = checks.find((c) => c.name.startsWith("ci/semaphoreci"));
    expect(semaphore).toMatchObject({ workflow: null, startedAt: null, completedAt: null });
    expect(semaphore?.link).toMatch(/^https:\/\/acme\.semaphoreci\.com\//);
    expect(checks[3]).toMatchObject({ workflow: "Review deployment" });
    expect(checks[3]?.startedAt).toMatch(/^2026-/);
  });

  it("treats a bucket gh adds later as still running", () => {
    const [check] = parseChecks(JSON.stringify([{ name: "x", bucket: "queued" }]));
    expect(check?.bucket).toBe("pending");
  });
});

describe("isNoChecksError", () => {
  it("recognises gh's 'no checks reported'", () => {
    const error = Object.assign(new Error("Command failed: gh pr checks"), {
      stderr: "no checks reported on the 'fix/x' branch\n",
    });
    expect(isNoChecksError(error)).toBe(true);
    expect(isNoChecksError(new Error("HTTP 401: Bad credentials"))).toBe(false);
  });
});
