import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_STATIONS, hubCandidateOf, updateLineSchema } from "@zastava/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { hubOfRepo, hubRepos, isHubRoot } from "../src/modules/projects/work-hub";

const root = mkdtempSync(path.join(os.tmpdir(), "zastava-api-hub-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("work hubs (spec 0012)", () => {
  it("recognises a hub and lists only its git checkouts", () => {
    const hub = path.join(root, "work");
    mkdirSync(path.join(hub, "repos", "frontend", ".git"), { recursive: true });
    mkdirSync(path.join(hub, "repos", "notes"), { recursive: true });
    expect(isHubRoot(hub)).toBe(false);
    writeFileSync(path.join(hub, "AGENTS.md"), "rules\n");
    expect(isHubRoot(hub)).toBe(true);
    expect(hubRepos(hub)).toEqual([
      { name: "frontend", path: path.join(hub, "repos", "frontend") },
    ]);
    expect(hubOfRepo(path.join(hub, "repos", "frontend"))).toBe(hub);
    expect(hubOfRepo(hub)).toBeNull();
  });

  it("derives the hub candidate from the path alone", () => {
    expect(hubCandidateOf("/a/work/repos/api/")).toBe("/a/work");
    expect(hubCandidateOf("/a/work/api")).toBeNull();
    expect(hubCandidateOf("/repos/api")).toBeNull();
  });

  it("rejects shift stations in a line: builders work in shifts themselves", () => {
    const shift = {
      key: "shifts",
      kind: "shift" as const,
      name: "Shifts",
      role: "builder",
      model: "m",
      allowedTools: [],
      prompt: "",
      goal: "g",
      doneCommand: null,
      handoffAtPct: 50,
      maxShifts: 8,
      reviewHandoff: false,
    };
    expect(updateLineSchema.safeParse({ stations: DEFAULT_STATIONS }).success).toBe(true);
    expect(updateLineSchema.safeParse({ stations: [...DEFAULT_STATIONS, shift] }).success).toBe(
      false,
    );
  });
});
