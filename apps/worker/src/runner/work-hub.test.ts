import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  hubOfRepo,
  hubOfWorktree,
  hubPlugin,
  hubPromptSection,
  hubWorktreePath,
  linkableIgnored,
  linkIgnoredFiles,
  pluginName,
} from "./work-hub";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

/** <tmp>/work with CLAUDE.md, a skill and repos/app (a git repo with an ignored .env). */
function makeHub(): { hub: string; repo: string } {
  const hub = path.join(mkdtempSync(path.join(os.tmpdir(), "zastava-hub-")), "work");
  const repo = path.join(hub, "repos", "app");
  mkdirSync(path.join(hub, ".claude", "skills", "domain"), { recursive: true });
  writeFileSync(path.join(hub, "CLAUDE.md"), "hub rules\n");
  writeFileSync(
    path.join(hub, ".claude", "skills", "domain", "SKILL.md"),
    "---\nname: domain\n---\n",
  );
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n*.log\n");
  writeFileSync(path.join(repo, "index.js"), "1\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(path.join(repo, ".env"), "TOKEN=x\n");
  writeFileSync(path.join(repo, "debug.log"), "noise\n");
  mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "\n");
  return { hub, repo };
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe("work hubs (spec 0012)", () => {
  it("keeps plain ignored files and drops folders, logs and .DS_Store", () => {
    expect(
      linkableIgnored([
        ".env",
        "node_modules/",
        "config/application.yml",
        "a.log",
        ".DS_Store",
        "",
      ]),
    ).toEqual([".env", "config/application.yml"]);
  });

  it("names worktrees and plugins the hub's way", () => {
    expect(hubWorktreePath("/h/work", "/h/work/repos/frontend", "fix-x-1a2b3c4d")).toBe(
      "/h/work/worktrees/frontend-zastava-fix-x-1a2b3c4d",
    );
    expect(pluginName("/Users/me/Acme Work")).toBe("acme-work");
    expect(hubPromptSection("/h/work", "/h/work/worktrees/x")).toContain("Do not create worktrees");
  });

  it("finds the hub from a repo or a worktree, links ignored config and builds the skills plugin", async () => {
    const { hub, repo } = makeHub();
    made.push(hub);
    expect(hubOfRepo(repo)).toBe(hub);
    expect(hubOfRepo(hub)).toBeNull();

    const worktree = hubWorktreePath(hub, repo, "t-1");
    git(repo, "worktree", "add", "-q", "-b", "t", worktree);
    expect(hubOfWorktree(worktree)).toBe(hub);
    expect(hubOfWorktree(repo)).toBeNull();

    expect(await linkIgnoredFiles(repo, worktree)).toEqual([".env"]);
    expect(readlinkSync(path.join(worktree, ".env"))).toBe(path.join(repo, ".env"));
    expect(existsSync(path.join(worktree, "debug.log"))).toBe(false);

    const plugin = await hubPlugin(hub);
    expect(plugin?.skills).toEqual(["domain"]);
    expect(existsSync(path.join(plugin?.path ?? "", "skills", "domain", "SKILL.md"))).toBe(true);
    rmSync(plugin?.path ?? "", { recursive: true, force: true });
  });
});
