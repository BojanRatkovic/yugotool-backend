import type { AgentStation } from "@yugotool/contracts";
import { updateLineSchema } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { buildPrompt, knowledgeSection } from "./line-logic";

const research: AgentStation = {
  key: "research",
  kind: "agent",
  name: "Research",
  role: "codebase-researcher",
  model: "claude-haiku-4-5-20251001",
  allowedTools: ["Read", "Grep", "Glob"],
  canEdit: false,
  useKnowledge: true,
  prompt: "",
};

const work = {
  name: "work",
  dir: "/k/work/abc",
  sha: "a1b2c3d4e5",
  entryFile: "knowledge/INDEX.md",
};

describe("knowledge in the prompt", () => {
  it("lists where each source is and where to start, without content", () => {
    const section = knowledgeSection([work]);
    expect(section).toContain("## Team knowledge (read-only)");
    expect(section).toContain("- work (a1b2c3d): `/k/work/abc` (start at `knowledge/INDEX.md`)");
    expect(section).toContain("do not apply here");
  });

  it("is absent without sources", () => {
    const run = { title: "T", description: "", branch: "b" };
    expect(buildPrompt(run, research, [], [])).not.toContain("Team knowledge");
    expect(buildPrompt(run, research, [], [work])).toContain("Team knowledge");
  });
});

describe("updateLineSchema", () => {
  it("refuses knowledge on a station that edits code", () => {
    const builder = { ...research, key: "build", canEdit: true };
    expect(updateLineSchema.safeParse({ stations: [research] }).success).toBe(true);
    expect(updateLineSchema.safeParse({ stations: [builder] }).success).toBe(false);
  });
});
