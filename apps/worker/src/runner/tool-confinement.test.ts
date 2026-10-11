import { describe, expect, it } from "vitest";
import { pathViolation } from "./tool-confinement";
import { deliveryViolation as delivery } from "./tool-confinement";

const wt = "/Users/me/.zastava/worktrees/run1";

describe("pathViolation", () => {
  it("allows paths inside the worktree, absolute or relative", () => {
    expect(pathViolation("Edit", { file_path: `${wt}/index.html` }, wt)).toBeNull();
    expect(pathViolation("Write", { file_path: "src/a.ts" }, wt)).toBeNull();
    expect(pathViolation("Grep", { path: "." }, wt)).toBeNull();
    expect(pathViolation("Glob", { pattern: "**/*.ts" }, wt)).toBeNull();
  });

  it("refuses the main checkout, siblings and traversal", () => {
    expect(
      pathViolation("Edit", { file_path: "/Users/me/.zastava/qa-lab/index.html" }, wt),
    ).toMatch(/outside/);
    expect(pathViolation("Write", { file_path: `${wt}-evil/x` }, wt)).toMatch(/outside/);
    expect(pathViolation("Read", { file_path: "../run2/secret" }, wt)).toMatch(/outside/);
    expect(pathViolation("NotebookEdit", { notebook_path: "/tmp/n.ipynb" }, wt)).toMatch(/outside/);
  });

  it("lets reads, not writes, use extra read roots", () => {
    const art = "/Users/me/.zastava/artifacts/run1";
    expect(pathViolation("Read", { file_path: `${art}/qa/1/home-pr.png` }, wt, [art])).toBeNull();
    expect(pathViolation("Write", { file_path: `${art}/x.png` }, wt, [art])).toMatch(/outside/);
  });

  it("ignores tools without paths", () => {
    expect(pathViolation("Bash", { command: "rm -rf /" }, wt)).toBeNull();
    expect(pathViolation("mcp__playwright__browser_click", { ref: "e1" }, wt)).toBeNull();
  });
});

describe("delivery commands", () => {
  it("refuses commit, push and opening a PR, and nothing else", () => {
    for (const command of [
      "git commit -m x",
      "git -C repo push origin HEAD",
      "cd api && git push",
      "gh pr create --fill",
      "rubocop -a; git commit -am fix",
    ])
      expect(delivery("Bash", { command })).not.toBeNull();
    for (const command of [
      "git status",
      "git log --oneline",
      "git diff",
      "echo 'git commit later'x",
      "gh pr view 1",
    ])
      expect(delivery("Bash", { command })).toBeNull();
    expect(delivery("Read", { command: "git push" })).toBeNull();
  });
});
