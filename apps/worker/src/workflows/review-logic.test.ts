import {
  REVIEW_LINE_STATIONS,
  type AgentStation,
  type PreviousFinding,
  type ReviewVerdict,
} from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  checksFinding,
  mergeFindings,
  qaFinding,
  reconcilePrevious,
} from "./review-logic";

function reviewerStation(): AgentStation {
  const station = REVIEW_LINE_STATIONS[0];
  if (station?.kind !== "agent") throw new Error("the review line starts with its reviewer");
  return station;
}
const reviewer = reviewerStation();
const clean: ReviewVerdict = {
  recommendation: "approve",
  summary: "Fine.",
  findings: [],
  previous: [],
};

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
    expect(prompt).not.toContain("## Previous findings");
  });

  it("asks for a status per previous finding on a re-review", () => {
    const prompt = buildReviewPrompt(
      {
        title: "Add paging",
        pullRequest: { number: 7, url: "https://x/pull/7", previousFindings: 2 },
      },
      reviewer,
      [],
    );
    expect(prompt).toContain("## Previous findings");
    expect(prompt).toContain("`fixed`, `partly` or `open`");
    expect(prompt).toContain("Never repeat a previous finding in `findings`");
  });
});

const prev = (id: string, severity: "critical" | "minor"): PreviousFinding => ({
  id,
  severity,
  category: "bug",
  file: "src/a.ts",
  line: 1,
  title: "t",
  body: "b",
  posted: true,
  threadId: null,
  threadResolved: null,
});

describe("reconcilePrevious", () => {
  const previous = [prev("f1", "critical"), prev("f2", "minor")];

  it("drops unknown ids and repeats", () => {
    const out = reconcilePrevious(
      {
        ...clean,
        previous: [
          { id: "f1", status: "fixed", note: "src/a.ts:3" },
          { id: "f1", status: "open", note: "again" },
          { id: "f9", status: "open", note: "made up" },
        ],
      },
      previous,
    );
    expect(out.previous).toEqual([{ id: "f1", status: "fixed", note: "src/a.ts:3" }]);
    expect(out.recommendation).toBe("approve");
  });

  it("asks for changes while a previous critical finding is not fixed", () => {
    for (const status of ["open", "partly"] as const) {
      const out = reconcilePrevious(
        { ...clean, previous: [{ id: "f1", status, note: "still there" }] },
        previous,
      );
      expect(out.recommendation).toBe("request_changes");
    }
  });

  it("keeps the recommendation when only a minor one is open", () => {
    const out = reconcilePrevious(
      { ...clean, recommendation: "comment", previous: [{ id: "f2", status: "open", note: "n" }] },
      previous,
    );
    expect(out.recommendation).toBe("comment");
  });

  it("asks for changes for a new critical finding", () => {
    const critical = checksFinding(
      { key: "lint", kind: "checks", name: "Lint", command: "pnpm lint" },
      "x",
      1,
    );
    const out = reconcilePrevious(
      { ...clean, findings: [{ ...critical, severity: "critical" }] },
      [],
    );
    expect(out.recommendation).toBe("request_changes");
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
        previous: [],
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
