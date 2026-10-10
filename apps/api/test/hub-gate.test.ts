import { describe, expect, it } from "vitest";
import { gateRepoProblem, type HubGateContext } from "../src/modules/runs/hub-gate";

const hub: HubGateContext = {
  kind: "hub",
  runRepo: null,
  presetRepo: null,
  researchRepo: "api",
  repos: ["api", "web"],
};
const approve = { decision: "approve" as const, comment: "" };

describe("gate repo choice (spec 0014)", () => {
  it("accepts a hub repo before the worktree exists", () => {
    expect(gateRepoProblem(hub, { ...approve, repo: "web" })).toBeNull();
    expect(gateRepoProblem(hub, approve)).toBeNull();
  });

  it("refuses an unknown repo, a repo after the worktree, and a repo on a repo project", () => {
    expect(gateRepoProblem(hub, { ...approve, repo: "nope" })).toMatch(/not a repo of this hub/);
    expect(gateRepoProblem({ ...hub, runRepo: "api" }, { ...approve, repo: "web" })).toMatch(
      /already works in api/,
    );
    expect(
      gateRepoProblem({ ...hub, kind: "repo", repos: [] }, { ...approve, repo: "web" }),
    ).toMatch(/only hub projects/);
  });

  it("needs a repo to approve when none is known; reject and changes don't", () => {
    const unknown = { ...hub, researchRepo: null };
    expect(gateRepoProblem(unknown, approve)).toMatch(/pick the repo/);
    expect(gateRepoProblem(unknown, { decision: "reject", comment: "" })).toBeNull();
    expect(gateRepoProblem({ ...unknown, presetRepo: "web" }, approve)).toBeNull();
  });

  it("repo projects decide as before", () => {
    const repo: HubGateContext = { ...hub, kind: "repo", researchRepo: null, repos: [] };
    expect(gateRepoProblem(repo, approve)).toBeNull();
    expect(gateRepoProblem(repo, { decision: "request_changes", comment: "x" })).toBeNull();
  });
});
