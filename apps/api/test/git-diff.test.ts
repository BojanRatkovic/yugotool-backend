import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchDiff, parseDiffFiles, worktreeDiff } from "../src/modules/runs/git-diff";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

describe("worktreeDiff", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "yugotool-diff-"));
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

  it("caps a huge patch but still lists every file", async () => {
    const diff = await worktreeDiff(repo, "main", { patchChars: 200_000, listChars: 5_000_000 });
    expect(diff.truncated).toBe(true);
    expect(diff.patch).toHaveLength(200_000);
    expect(diff.patch.startsWith("diff --git")).toBe(true);
    expect(diff.files).toHaveLength(2_001);
    expect(diff.files[0]).toEqual({
      path: "big.txt",
      oldPath: null,
      status: "added",
      additions: 300_000,
      deletions: 0,
      binary: false,
    });
  });

  it("returns the full diff when it fits", async () => {
    git(repo, "checkout", "-q", "main");
    writeFileSync(path.join(repo, "README.md"), "hello world\n");
    const diff = await worktreeDiff(repo, "main", { patchChars: 1_000_000, listChars: 50_000 });
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain("+hello world");
    expect(diff.files.map((file) => file.path)).toContain("README.md");
  });

  it("rejects when git fails", async () => {
    await expect(
      worktreeDiff(repo, "no-such-branch", { patchChars: 1_000, listChars: 1_000 }),
    ).rejects.toThrow(/exited with/);
  });
});

describe("worktreeDiff base", () => {
  let upstream: string;
  let clone: string;

  beforeAll(() => {
    upstream = mkdtempSync(path.join(tmpdir(), "yugotool-upstream-"));
    git(upstream, "init", "-q", "-b", "main");
    git(upstream, "config", "user.email", "test@example.com");
    git(upstream, "config", "user.name", "test");
    writeFileSync(path.join(upstream, "a.txt"), "a\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "init");
    clone = mkdtempSync(path.join(tmpdir(), "yugotool-clone-"));
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
    const diff = await worktreeDiff(clone, "main", { patchChars: 100_000, listChars: 10_000 });
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
  });
});

describe("branchDiff", () => {
  it("reads a finished run's changes from its branch, without a worktree", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "yugotool-branchdiff-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "yugotool/run");
    // The base moves on after the run branched off; that is not the run's change.
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "later on main");
    git(repo, "checkout", "-q", "yugotool/run");
    writeFileSync(path.join(repo, "a.txt"), "run change\n");
    git(repo, "commit", "-q", "-am", "wip");
    git(repo, "checkout", "-q", "main");

    const diff = await branchDiff(repo, "yugotool/run", "main", {
      patchChars: 100_000,
      listChars: 10_000,
    });
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(diff.patch).toContain("+run change");
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("parseDiffFiles", () => {
  it("reads renames, binaries and statuses from the -z listings", () => {
    const numstat =
      "3\t1\tsrc/a.ts\0" +
      "0\t0\t\0old name.ts\0new name.ts\0" +
      "-\t-\tlogo.png\0" +
      "0\t4\tgone.ts\0";
    const nameStatus = "M\0src/a.ts\0R100\0old name.ts\0new name.ts\0A\0logo.png\0D\0gone.ts\0";
    expect(parseDiffFiles(numstat, nameStatus)).toEqual([
      {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
        binary: false,
      },
      {
        path: "new name.ts",
        oldPath: "old name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
      },
      {
        path: "logo.png",
        oldPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        binary: true,
      },
      {
        path: "gone.ts",
        oldPath: null,
        status: "deleted",
        additions: 0,
        deletions: 4,
        binary: false,
      },
    ]);
  });
});

describe("worktreeDiff index", () => {
  it("lists a new file without marking it in the worktree's own index", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "yugotool-diffindex-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(path.join(repo, "new.txt"), "new\n");

    const diff = await worktreeDiff(repo, "main", { patchChars: 100_000, listChars: 10_000 });

    expect(diff.files.map((file) => file.path)).toEqual(["new.txt"]);
    // The run's delivery owns the index: a diff refresh must leave it (and its lock) alone.
    expect(git(repo, "status", "--porcelain").toString()).toBe("?? new.txt\n");
    rmSync(repo, { recursive: true, force: true });
  });
});
