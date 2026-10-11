import {
  RESEARCH_PLAN_JSON_SCHEMA,
  createWorkOrderSchema,
  gateDecisionSchema,
  projectSchema,
  researchPlanSchema,
  splitWorkOrderSchema,
  workOrderSchema,
} from "@yugotool/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-10-10T12:00:00.000Z";

describe("hub project contracts (spec 0014)", () => {
  it("parses a hub project with its repos", () => {
    const project = projectSchema.parse({
      id: "0199d0a4-0000-7000-8000-000000000001",
      kind: "hub",
      name: "shop-work",
      repoPath: "/w/shop-work",
      baseBranch: "main",
      preview: null,
      deliveryDefault: "local",
      hubPath: "/w/shop-work",
      claudeAccountId: null,
      repos: [
        {
          name: "shop-backend",
          path: "/w/shop-work/repos/shop-backend",
          baseBranch: "develop",
          preview: null,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    expect(project.kind).toBe("hub");
    expect(project.repos[0]?.baseBranch).toBe("develop");
  });

  it("rejects an unknown project kind", () => {
    expect(projectSchema.shape.kind.safeParse("workspace").success).toBe(false);
  });

  it("takes a repo override with a plan gate approval", () => {
    const decision = gateDecisionSchema.parse({ decision: "approve", repo: "shop-frontend" });
    expect(decision).toMatchObject({ decision: "approve", repo: "shop-frontend", comment: "" });
    expect(gateDecisionSchema.parse({ decision: "approve" }).repo).toBeUndefined();
    expect(gateDecisionSchema.safeParse({ decision: "approve", repo: " " }).success).toBe(false);
  });

  it("parses a research plan with and without a split", () => {
    expect(researchPlanSchema.parse({ plan: "p", repo: "api" }).split).toBeUndefined();
    const plan = researchPlanSchema.parse({
      plan: "p",
      repo: "api",
      split: [
        { title: "Add endpoint", description: "…", repo: "api" },
        { title: "Use endpoint", description: "…", repo: "web" },
      ],
    });
    expect(plan.split?.map((s) => s.repo)).toEqual(["api", "web"]);
  });

  it("exports a draft-7 research plan JSON schema without a $schema URI", () => {
    expect(RESEARCH_PLAN_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(RESEARCH_PLAN_JSON_SCHEMA).toMatchObject({
      type: "object",
      required: ["plan", "repo"],
    });
    expect(Object.keys(RESEARCH_PLAN_JSON_SCHEMA["properties"] as object)).toEqual([
      "plan",
      "repo",
      "split",
    ]);
  });

  it("work orders carry repo and followsId; create takes a preset repo", () => {
    expect(workOrderSchema.shape.repo.parse(null)).toBeNull();
    expect(workOrderSchema.shape.followsId.parse(null)).toBeNull();
    const create = createWorkOrderSchema.parse({
      projectId: "0199d0a4-0000-7000-8000-000000000001",
      title: "Fix login",
      repo: "web",
    });
    expect(create.repo).toBe("web");
  });

  it("a split needs at least two items", () => {
    const item = { title: "a", description: "", repo: "api" };
    expect(splitWorkOrderSchema.safeParse({ items: [item] }).success).toBe(false);
    expect(splitWorkOrderSchema.safeParse({ items: [item, item] }).success).toBe(true);
  });
});
