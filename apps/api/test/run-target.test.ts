import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTarget } from "@zastava/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { removeProjectFiles } from "../src/modules/projects/project-cleanup";

const root = mkdtempSync(path.join(os.tmpdir(), "zastava-run-target-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

const preview = {
  install: null,
  start: "pnpm dev --port $PORT",
  readyPath: "/",
  readyTimeoutSec: 120,
  env: {},
  baseUrlPath: "/",
  themeInit: null,
  host: null,
};

describe("runTarget (spec 0014)", () => {
  const repoProject = {
    kind: "repo" as const,
    repoPath: "/w/app",
    baseBranch: "main",
    preview,
    repoSettings: null,
  };
  const hubProject = {
    kind: "hub" as const,
    repoPath: "/w/hub/",
    baseBranch: "main",
    preview: null,
    repoSettings: { web: { baseBranch: "develop", preview } },
  };

  it("a repo project's runs use the project as before, whatever the run says", () => {
    expect(runTarget(repoProject, null)).toEqual({
      repoPath: "/w/app",
      baseBranch: "main",
      preview,
    });
    expect(runTarget(repoProject, "web")).toEqual(runTarget(repoProject, null));
  });

  it("a hub run uses its repo, that repo's base branch and preview", () => {
    expect(runTarget(hubProject, "web")).toEqual({
      repoPath: "/w/hub/repos/web",
      baseBranch: "develop",
      preview,
    });
    expect(runTarget(hubProject, "api")).toEqual({
      repoPath: "/w/hub/repos/api",
      baseBranch: "main",
      preview: null,
    });
    expect(runTarget(hubProject, null).repoPath).toBe("/w/hub/");
  });
});

describe("removeProjectFiles for a hub project", () => {
  it("removes run worktrees from their repos and prunes them; repos and branches stay", async () => {
    const hub = path.join(root, "hub");
    const api = path.join(hub, "repos", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(path.join(hub, "CLAUDE.md"), "# hub\n");
    git(api, "init", "-q", "-b", "main");
    git(api, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(hub, "worktrees", "api-zastava-x-12345678");
    git(api, "worktree", "add", "-q", "-b", "zastava/x", wt);
    const outside = path.join(root, "elsewhere");
    mkdirSync(outside);

    const failed = await removeProjectFiles({
      projectId: crypto.randomUUID(),
      kind: "hub",
      repoPath: hub,
      worktrees: [
        { runId: "r1", worktreePath: wt, repo: "api" },
        { runId: "r2", worktreePath: outside, repo: "api" },
      ],
      runIds: [],
    });
    expect(failed).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(git(api, "worktree", "list")).not.toContain("api-zastava-x");
    expect(git(api, "branch", "--list", "zastava/x")).toContain("zastava/x");
  });
});
