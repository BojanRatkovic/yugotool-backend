import { DEFAULT_STATIONS, requestChangesTarget, type Station } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { buildFollowUp } from "./line-logic";

const keyAt = (stations: Station[], index: number) => stations[index]?.key;
const gate = (stations: Station[], key: string) => stations.findIndex((s) => s.key === key);

describe("requestChangesTarget", () => {
  it("sends plan-gate changes back to research (nothing edits before it)", () => {
    const line = DEFAULT_STATIONS;
    expect(keyAt(line, requestChangesTarget(line, gate(line, "plan_gate")))).toBe("research");
  });

  it("sends final-gate changes to the builder, not the read-only validator after it", () => {
    const line = DEFAULT_STATIONS;
    expect(keyAt(line, requestChangesTarget(line, gate(line, "review_gate")))).toBe("build");
  });

  it("returns -1 when no agent comes before the gate", () => {
    const line = DEFAULT_STATIONS.filter((s) => s.kind === "gate");
    expect(requestChangesTarget(line, 0)).toBe(-1);
  });
});

describe("buildFollowUp", () => {
  const note = { station: "Approve plan (changes requested)", text: "Use the existing Button." };

  it("asks an editing station to change the worktree", () => {
    expect(buildFollowUp(note)).toMatch(/same worktree/);
  });

  it("asks a read-only station for the full revised result, without touching files", () => {
    const prompt = buildFollowUp(note, false);
    expect(prompt).toMatch(/Do not modify any files/);
    expect(prompt).toMatch(/full revised plan/);
    expect(prompt).toContain("Use the existing Button.");
  });
});
