import { describe, expect, it } from "vitest";
import { humanText } from "../workflows/line-logic";
import { skillNote, skillPlan, skillSection } from "./station-skills";

describe("station skills (spec 0015)", () => {
  const available = ["work:development", "rails-way", "copy"];

  it("loads the station's skills, then the ones the text names, once each", () => {
    expect(
      skillPlan(
        ["rails-way", "gone"],
        "Use /work:development and /rails-way, not src/copy or /api/x",
        available,
      ),
    ).toEqual({ load: ["rails-way", "work:development"], missing: ["gone"] });
  });

  it("ends a name before sentence punctuation, not inside a file name", () => {
    expect(skillPlan([], "Follow /rails-way. Then /copy, and /copy.md", available).load).toEqual([
      "rails-way",
      "copy",
    ]);
  });

  it("asks for nothing when nothing is named", () => {
    expect(skillPlan([], "Fix /health endpoint", available).load).toEqual([]);
    expect(skillSection([])).toBeNull();
    expect(skillSection(["copy"])).toContain("`copy`");
  });
});

describe("human text (spec 0015)", () => {
  it("keeps the description and people's gate comments, not agents' notes", () => {
    const notes = [
      { station: "Research", text: "Plan: … push via /p-dev:open-pr" },
      { station: "Approve plan", text: "Human reviewer: use /rails-way", human: true },
    ];
    const text = humanText("Do it with /work:dev", notes, {
      station: "Gate",
      text: "/copy too",
      human: true,
    });
    expect(text).toBe("Do it with /work:dev\nHuman reviewer: use /rails-way\n/copy too");
    expect(text).not.toContain("open-pr");
  });
});

describe("skillNote", () => {
  it("names skills to load and the missing ones", () => {
    expect(skillNote({ load: ["a", "b"], missing: ["c"] })).toBe(
      "Skills to load: a, b · not available here: c",
    );
    expect(skillNote({ load: [], missing: ["c"] })).toBe("not available here: c");
  });

  it("is null when there is nothing to say", () => {
    expect(skillNote({ load: [], missing: [] })).toBeNull();
  });
});
