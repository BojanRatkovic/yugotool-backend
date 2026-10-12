import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hubOfRepo } from "@yugotool/local";
import {
  hubOfWorktree,
  bundledHubPlugins,
  hubInstructions,
  hubPlugin,
  hubPlugins,
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
  const hub = path.join(mkdtempSync(path.join(os.tmpdir(), "yugotool-hub-")), "work");
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
      "/h/work/worktrees/frontend-yugotool-fix-x-1a2b3c4d",
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

    mkdirSync(path.join(repo, ".cache"));
    writeFileSync(path.join(repo, ".cache", ".gitignore"), "*\n");
    writeFileSync(path.join(repo, ".cache", "index.bin"), "x");
    expect(await linkIgnoredFiles(repo, worktree)).toEqual([
      ".cache/.gitignore",
      ".cache/index.bin",
      ".env",
    ]);
    expect(readlinkSync(path.join(worktree, ".env"))).toBe(path.join(repo, ".env"));
    expect(lstatSync(path.join(worktree, ".cache", ".gitignore")).isFile()).toBe(true);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(worktree, "debug.log"))).toBe(false);

    const plugin = await hubPlugin(hub);
    expect(plugin?.skills).toEqual(["domain"]);
    expect(existsSync(path.join(plugin?.path ?? "", "skills", "domain", "SKILL.md"))).toBe(true);
    rmSync(plugin?.path ?? "", { recursive: true, force: true });
  });

  it("expands the hub's CLAUDE.md imports and loads the plugins it ships", async () => {
    const { hub } = makeHub();
    made.push(hub);
    writeFileSync(path.join(hub, "CLAUDE.md"), "@AGENTS.md\n@../outside.md\n");
    writeFileSync(path.join(hub, "AGENTS.md"), "Auto-preview by default.\n");
    const instructions = await hubInstructions(hub);
    expect(instructions).toContain("Auto-preview by default.");
    expect(instructions).toContain("@../outside.md");

    const shipped = path.join(hub, "plugins", "work-skills");
    mkdirSync(path.join(shipped, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(shipped, ".claude-plugin", "plugin.json"), '{"name":"work-skills"}\n');
    mkdirSync(path.join(hub, "plugins", "notes"), { recursive: true });
    expect(bundledHubPlugins(hub)).toEqual([shipped]);
    const plugins = await hubPlugins(hub);
    expect(plugins.map((p) => p.path)).toContain(shipped);
    expect(plugins).toHaveLength(2);
    for (const p of plugins)
      if (p.path !== shipped) rmSync(p.path, { recursive: true, force: true });
  });
});
