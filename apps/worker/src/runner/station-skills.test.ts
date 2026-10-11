import { describe, expect, it } from "vitest";
import { skillPlan, skillSection } from "./station-skills";

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

  it("asks for nothing when nothing is named", () => {
    expect(skillPlan([], "Fix /health endpoint", available).load).toEqual([]);
    expect(skillSection([])).toBeNull();
    expect(skillSection(["copy"])).toContain("`copy`");
  });
});
