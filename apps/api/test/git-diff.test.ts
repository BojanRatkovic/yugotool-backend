import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worktreeDiff } from "../src/modules/runs/git-diff";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

describe("worktreeDiff", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "zastava-diff-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    // A committed 30MB file (past the old 20MB maxBuffer) plus many untracked files.
    git(repo, "checkout", "-q", "-b", "work");
    writeFileSync(path.join(repo, "big.txt"), `${"x".repeat(99)}\n`.repeat(300_000));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "big");
    for (let i = 0; i < 2_000; i++)
      writeFileSync(path.join(repo, `untracked-file-with-a-long-name-${i}.txt`), `${i}\n`);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("caps a huge patch and stat instead of failing", async () => {
    const diff = await worktreeDiff(repo, "main", { patchChars: 200_000, statChars: 5_000 });
    expect(diff.truncated).toBe(true);
    expect(diff.patch).toHaveLength(200_000);
    expect(diff.patch.startsWith("diff --git")).toBe(true);
    expect(diff.stat.length).toBeLessThan(6_000);
    expect(diff.stat).toMatch(/2001 files changed/);
  });

  it("returns the full diff when it fits", async () => {
    git(repo, "checkout", "-q", "main");
    writeFileSync(path.join(repo, "README.md"), "hello world\n");
    const diff = await worktreeDiff(repo, "main", { patchChars: 1_000_000, statChars: 50_000 });
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain("+hello world");
    expect(diff.stat).toMatch(/README\.md/);
  });

  it("rejects when git fails", async () => {
    await expect(
      worktreeDiff(repo, "no-such-branch", { patchChars: 1_000, statChars: 1_000 }),
    ).rejects.toThrow(/exited with/);
  });
});

describe("worktreeDiff base", () => {
  let upstream: string;
  let clone: string;

  beforeAll(() => {
    upstream = mkdtempSync(path.join(tmpdir(), "zastava-upstream-"));
    git(upstream, "init", "-q", "-b", "main");
    git(upstream, "config", "user.email", "test@example.com");
    git(upstream, "config", "user.name", "test");
    writeFileSync(path.join(upstream, "a.txt"), "a\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "init");
    clone = mkdtempSync(path.join(tmpdir(), "zastava-clone-"));
    execFileSync("git", ["clone", "-q", upstream, clone], { stdio: "pipe" });
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "test");
    // origin/main moves on; the clone's local main stays behind (like a stale checkout).
    for (const name of ["b.txt", "c.txt"]) {
      writeFileSync(path.join(upstream, name), `${name}\n`);
      git(upstream, "add", ".");
      git(upstream, "commit", "-q", "-m", name);
    }
    git(clone, "fetch", "-q", "origin");
    // The run's branch starts from origin/main, as worktrees do.
    git(clone, "checkout", "-q", "-b", "run", "origin/main");
    writeFileSync(path.join(clone, "a.txt"), "a changed\n");
  });

  afterAll(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  it("shows only the run's changes when the local base is stale", async () => {
    const diff = await worktreeDiff(clone, "main", { patchChars: 100_000, statChars: 10_000 });
    expect(diff.stat).toMatch(/a\.txt/);
    expect(diff.stat).not.toMatch(/b\.txt|c\.txt/);
    expect(diff.stat).toMatch(/1 file changed/);
  });
});
