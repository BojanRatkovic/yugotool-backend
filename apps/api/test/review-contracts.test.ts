import {
  DEFAULT_STATIONS,
  REVIEW_LINE_STATIONS,
  REVIEW_VERDICT_JSON_SCHEMA,
  postFindingsSchema,
  reviewVerdictSchema,
  updateLineSchema,
  updateReviewLineSchema,
} from "@zastava/contracts";
import { describe, expect, it } from "vitest";

const finding = {
  id: "f1",
  severity: "critical",
  category: "bug",
  file: "src/a.ts",
  side: "RIGHT",
  startLine: null,
  line: 12,
  title: "Null deref when the list is empty",
  body: "`items[0]` is undefined for an empty list.",
  suggestion: null,
  confidence: "high",
} as const;

describe("reviewVerdictSchema", () => {
  it("accepts a verdict with anchored findings", () => {
    const parsed = reviewVerdictSchema.parse({
      recommendation: "request_changes",
      summary: "Adds paging.",
      findings: [finding],
    });
    expect(parsed.findings[0]?.line).toBe(12);
  });

  it("exports a draft-7 JSON schema without a $schema URI", () => {
    expect(REVIEW_VERDICT_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(REVIEW_VERDICT_JSON_SCHEMA).toMatchObject({ type: "object" });
    expect(JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA)).toContain("recommendation");
  });
});

describe("updateReviewLineSchema", () => {
  it("accepts the default review line", () => {
    expect(updateReviewLineSchema.safeParse({ stations: REVIEW_LINE_STATIONS }).success).toBe(true);
    expect(updateLineSchema.safeParse({ stations: REVIEW_LINE_STATIONS }).success).toBe(true);
  });

  it("rejects gates, shifts and editing stations", () => {
    // DEFAULT_STATIONS has gates and a builder.
    expect(updateReviewLineSchema.safeParse({ stations: DEFAULT_STATIONS }).success).toBe(false);
    const builder = DEFAULT_STATIONS.find((s) => s.key === "build");
    expect(
      updateReviewLineSchema.safeParse({ stations: [...REVIEW_LINE_STATIONS, builder] }).success,
    ).toBe(false);
  });
});

describe("postFindingsSchema", () => {
  it("needs at least one finding", () => {
    expect(postFindingsSchema.safeParse({ findings: [] }).success).toBe(false);
    expect(
      postFindingsSchema.safeParse({
        findings: [{ id: "f1", title: "t", body: "b", suggestion: null }],
      }).success,
    ).toBe(true);
  });
});
