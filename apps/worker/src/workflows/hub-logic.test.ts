import { DEFAULT_STATIONS, type Station } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "./line-logic";
import { firstEditIndex, hubPlanIndex, runsInHub } from "./hub-logic";

const agent = (key: string, canEdit: boolean): Station => ({
  key,
  kind: "agent",
  name: key,
  role: key,
  model: "m",
  allowedTools: [],
  canEdit,
  prompt: "",
});
const gate = (key: string): Station => ({ key, kind: "gate", name: key, prompt: "" });

describe("hub run stations (spec 0014)", () => {
  it("the default line plans in the hub with Research", () => {
    expect(firstEditIndex(DEFAULT_STATIONS)).toBe(2);
    expect(hubPlanIndex(DEFAULT_STATIONS)).toBe(0);
    expect(DEFAULT_STATIONS.map((_, i) => runsInHub(DEFAULT_STATIONS, i))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("every read-only agent before the build runs in the hub; the first one plans", () => {
    const line = [agent("scout", false), agent("research", false), gate("g"), agent("build", true)];
    expect(hubPlanIndex(line)).toBe(0);
    expect(line.map((_, i) => runsInHub(line, i))).toEqual([true, true, false, false]);
  });

  it("validators after the build never run in the hub", () => {
    const line = [agent("build", true), agent("validate", false)];
    expect(hubPlanIndex(line)).toBe(-1);
    expect(runsInHub(line, 1)).toBe(false);
  });

  it("a read-only line runs wholly in the hub", () => {
    const line = [agent("research", false), gate("g")];
    expect(firstEditIndex(line)).toBe(-1);
    expect(hubPlanIndex(line)).toBe(0);
    expect(runsInHub(line, 0)).toBe(true);
  });

  it("the hub prompt replaces the worktree line; repo runs read as before", () => {
    const run = { title: "T", description: "D", branch: "yugotool/t" };
    const station = agent("research", false);
    if (station.kind !== "agent") throw new Error("agent expected");
    const regular = buildPrompt(run, station, []);
    expect(regular).toContain("You are working in a git worktree on branch `yugotool/t`.");
    expect(regular).toContain("`.yugotool/`");
    const inHub = buildPrompt({ ...run, branch: "", hub: "/w/hub" }, station, []);
    expect(inHub).toContain("You are in the work hub at `/w/hub`, read-only");
    expect(inHub).not.toContain("git worktree on branch");
    expect(inHub).not.toContain("`.yugotool/`");
  });
});
