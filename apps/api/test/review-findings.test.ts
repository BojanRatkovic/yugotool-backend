import type { ReviewFinding } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import { planPendingReview } from "../src/modules/pull-requests/review-findings";

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
