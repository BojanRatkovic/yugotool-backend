import { REVIEW_LINE_STATIONS, type AgentStation, type ReviewVerdict } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import { buildReviewPrompt, checksFinding, mergeFindings, qaFinding } from "./review-logic";

function reviewerStation(): AgentStation {
  const station = REVIEW_LINE_STATIONS[0];
  if (station?.kind !== "agent") throw new Error("the review line starts with its reviewer");
  return station;
}
const reviewer = reviewerStation();
const clean: ReviewVerdict = { recommendation: "approve", summary: "Fine.", findings: [] };

describe("buildReviewPrompt", () => {
  it("points at the brief and never asks for edits", () => {
    const prompt = buildReviewPrompt(
      { title: "Add paging", pullRequest: { number: 7, url: "https://x/pull/7" } },
      reviewer,
      [{ station: "Lint", text: "ok" }],
    );
    expect(prompt).toContain("#7 Add paging");
    expect(prompt).toContain(".zastava/review-brief.md");
    expect(prompt).toContain("Never modify");
    expect(prompt).toContain("### Lint\nok");
    expect(prompt).toContain("## Output format");
  });
});

describe("mergeFindings", () => {
  it("keeps the verdict as is without extra findings", () => {
    expect(mergeFindings(clean, [])).toBe(clean);
  });

  it("turns approve into comment for a failing check and sorts by severity", () => {
    const checks = checksFinding(
      { key: "lint", kind: "checks", name: "Lint", command: "pnpm lint" },
      "error x\n",
      1,
    );
    const merged = mergeFindings(
      {
        recommendation: "approve",
        summary: "s",
        findings: [{ ...checks, id: "f1", severity: "minor", category: "convention" }],
      },
      [checks],
    );
    expect(merged.recommendation).toBe("comment");
    expect(merged.findings.map((f) => f.id)).toEqual(["c1", "f1"]);
    expect(checks.body).toContain("error x");
    expect(mergeFindings(merged, [checks])).toBe(merged);
  });

  it("asks for changes when an extra finding is critical", () => {
    const qa = { ...qaFinding("QA", { status: "failed", summary: "s", report: "r" }, 1) };
    expect(mergeFindings(clean, [{ ...qa, severity: "critical" }]).recommendation).toBe(
      "request_changes",
    );
  });

  it("files a QA error as a minor finding", () => {
    const qa = qaFinding("QA", { status: "error", summary: "no preview", report: "" }, 2);
    expect(qa).toMatchObject({ id: "q2", severity: "minor", title: "QA could not run" });
  });
});
