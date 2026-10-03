import type { ReviewFinding, ReviewPullRequest } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import { freezePrevious, planPendingReview } from "../src/modules/pull-requests/review-findings";

const f = (patch: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1",
  severity: "important",
  category: "bug",
  file: "src/a.ts",
  side: "RIGHT",
  startLine: 10,
  line: 12,
  title: "t",
  body: "b",
  suggestion: null,
  confidence: "high",
  ...patch,
});

describe("planPendingReview", () => {
  it("keeps the review's anchors and the human's text", () => {
    const { plan } = planPendingReview(
      [f({})],
      [{ id: "f1", title: "Edited", body: "", suggestion: "x" }],
    );
    expect(plan.comments).toEqual([
      {
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        startLine: 10,
        startSide: "RIGHT",
        body: "**Edited**\n\n```suggestion\nx\n```",
      },
    ]);
    expect(plan.commentIds).toEqual(["f1"]);
    expect(plan.body).toBeNull();
  });

  it("puts file-level findings in the summary with their file and plain code", () => {
    const { plan, unknown } = planPendingReview(
      [f({ id: "f2", line: null, startLine: null })],
      [
        { id: "f2", title: "Split this", body: "Too long.", suggestion: "a()" },
        { id: "zz", title: "?", body: "", suggestion: null },
      ],
    );
    expect(plan.body).toBe("**Split this** (`src/a.ts`)\n\nToo long.\n\n```\na()\n```");
    expect(plan.bodyIds).toEqual(["f2"]);
    expect(unknown).toEqual(["zz"]);
  });
});

const pr = (patch: Partial<ReviewPullRequest>): ReviewPullRequest => ({
  number: 1,
  url: "u",
  headRefName: "h",
  headOid: "a",
  baseRefName: "main",
  baseOid: "b",
  sinceOid: null,
  openThreads: [],
  posted: [],
  postedThreads: {},
  previousFindings: [],
  ...patch,
});
const thread = (id: string) => ({ id, path: "src/a.ts", line: 1, author: "x", body: "b" });

describe("freezePrevious", () => {
  it("is empty without a done review and keeps every open thread", () => {
    const out = freezePrevious(null, { openThreads: [thread("T1")], threadResolved: {} });
    expect(out.previousFindings).toEqual([]);
    expect(out.openThreads).toEqual([{ path: "src/a.ts", line: 1, author: "x", body: "b" }]);
  });

  it("looks up each finding's thread state and drops my threads from openThreads", () => {
    const last = {
      pullRequest: pr({ posted: ["f1", "f2"], postedThreads: { f1: "T1", f2: "T2" } }),
      findings: [f({ id: "f1" }), f({ id: "f2" }), f({ id: "f3" })],
    };
    const out = freezePrevious(last, {
      openThreads: [thread("T1"), thread("T9")],
      threadResolved: { T1: false, T2: true, T9: false },
    });
    expect(out.previousFindings.map((p) => [p.id, p.posted, p.threadId, p.threadResolved])).toEqual(
      [
        ["f1", true, "T1", false],
        ["f2", true, "T2", true],
        ["f3", false, null, null],
      ],
    );
    expect(out.openThreads).toHaveLength(1);
  });

  it("says null when a posted thread is gone from GitHub", () => {
    const last = { pullRequest: pr({ postedThreads: { f1: "T1" } }), findings: [f({})] };
    const out = freezePrevious(last, { openThreads: [], threadResolved: {} });
    expect(out.previousFindings[0]?.threadResolved).toBeNull();
  });
});
