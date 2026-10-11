import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExcluded, syncKnowledgeSource } from "./knowledge";

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "yugotool-knowledge-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

/** A repo like a team's work repo: tracked knowledge, gitignored secrets. */
function workRepo(): string {
  const repo = temp();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  mkdirSync(path.join(repo, "knowledge"));
  writeFileSync(path.join(repo, "knowledge", "INDEX.md"), "# Index\n");
  writeFileSync(path.join(repo, "README.md"), "# Work\n");
  writeFileSync(path.join(repo, ".gitignore"), "/private\n.env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(path.join(repo, "private"));
  writeFileSync(path.join(repo, "private", "token.txt"), "secret");
  writeFileSync(path.join(repo, ".env"), "KEY=secret");
  return repo;
}

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "work",
  branch: null,
  excludes: [],
};

describe("isExcluded", () => {
  it("matches names with * wildcards", () => {
    const excludes = [".env*", "private", "secrets"];
    expect(isExcluded(".env", excludes)).toBe(true);
    expect(isExcluded(".env.local", excludes)).toBe(true);
    expect(isExcluded("private", excludes)).toBe(true);
    expect(isExcluded("private-notes.md", excludes)).toBe(false);
    expect(isExcluded("README.md", excludes)).toBe(false);
  });
});

describe("syncKnowledgeSource", () => {
  it("snapshots only tracked files of a local repo, at its head", async () => {
    const repo = workRepo();
    const mount = await syncKnowledgeSource(
      { ...base, kind: "git_local", location: repo, entryFile: "knowledge/INDEX.md" },
      temp(),
    );
    expect(mount.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(mount.entryFile).toBe("knowledge/INDEX.md");
    expect(existsSync(path.join(mount.dir, "knowledge", "INDEX.md"))).toBe(true);
    expect(existsSync(path.join(mount.dir, "private"))).toBe(false);
    expect(existsSync(path.join(mount.dir, ".env"))).toBe(false);
  });

  it("falls back to README.md when the entry file is missing", async () => {
    const mount = await syncKnowledgeSource(
      { ...base, kind: "git_local", location: workRepo(), entryFile: "nope.md" },
      temp(),
    );
    expect(mount.entryFile).toBe("README.md");
  });

  it("clones a remote and reads the requested branch", async () => {
    const repo = workRepo();
    git(repo, "checkout", "-q", "-b", "docs");
    writeFileSync(path.join(repo, "DOCS.md"), "branch only");
    git(repo, "add", "DOCS.md");
    git(repo, "commit", "-q", "-m", "docs");
    const mount = await syncKnowledgeSource(
      { ...base, kind: "git_remote", location: repo, branch: "docs", entryFile: null },
      temp(),
    );
    expect(existsSync(path.join(mount.dir, "DOCS.md"))).toBe(true);
  });

  it("copies a plain folder without excluded names", async () => {
    const repo = workRepo();
    const mount = await syncKnowledgeSource(
      { ...base, kind: "path", location: repo, entryFile: null, excludes: [".env*", "private"] },
      temp(),
    );
    expect(mount.sha).toBeNull();
    expect(existsSync(path.join(mount.dir, "README.md"))).toBe(true);
    expect(existsSync(path.join(mount.dir, "private"))).toBe(false);
    expect(existsSync(path.join(mount.dir, ".env"))).toBe(false);
    expect(existsSync(path.join(mount.dir, ".git"))).toBe(false);
  });

  it("wraps a single file in its own folder", async () => {
    const file = path.join(temp(), "conventions.md");
    writeFileSync(file, "# Conventions\n");
    const mount = await syncKnowledgeSource(
      { ...base, kind: "path", location: file, entryFile: null },
      temp(),
    );
    expect(mount.entryFile).toBe("conventions.md");
  });

  it("fails on a local path that is not a repo", async () => {
    await expect(
      syncKnowledgeSource(
        { ...base, kind: "git_local", location: temp(), entryFile: null },
        temp(),
      ),
    ).rejects.toThrow(/not a git repository/);
  });
});
