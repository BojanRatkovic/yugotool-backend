import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localRunner } from "./local-runner";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yugotool-uncommit-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@yugotool.local");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("uncommitSince", () => {
  it("turns an agent's commits back into working-tree changes", async () => {
    const dir = repo();
    const start = git(dir, "rev-parse", "HEAD");
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    writeFileSync(path.join(dir, "b.txt"), "new\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--no-verify", "-m", "agent commit");

    expect(await localRunner.uncommitSince(dir, start)).toBe(1);
    expect(git(dir, "rev-parse", "HEAD")).toBe(start);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("changed\n");
    expect(git(dir, "status", "--porcelain")).toBe("M a.txt\n?? b.txt");
  });

  it("leaves a clean history alone", async () => {
    const dir = repo();
    const start = git(dir, "rev-parse", "HEAD");
    expect(await localRunner.uncommitSince(dir, start)).toBe(0);
    expect(git(dir, "rev-parse", "HEAD")).toBe(start);
  });
});

describe("moveNewUntracked", () => {
  it("moves only files that appeared after the snapshot", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "mine.txt"), "user\n");
    const before = await localRunner.untrackedFiles(dir);
    writeFileSync(path.join(dir, "s1_focused.png"), "png");
    const out = mkdtempSync(path.join(tmpdir(), "yugotool-artifacts-"));

    expect(await localRunner.moveNewUntracked(dir, before, out)).toEqual(["s1_focused.png"]);
    expect(git(dir, "status", "--porcelain")).toBe("?? mine.txt");
    expect(readFileSync(path.join(out, "s1_focused.png"), "utf8")).toBe("png");
  });
});

describe("checkCommitMessage", () => {
  it("is null without a commit-msg hook", async () => {
    expect(await localRunner.checkCommitMessage(repo(), "Add a footer")).toBeNull();
  });

  it("runs the hook over the delivery message", async () => {
    const dir = repo();
    const hook = path.join(dir, ".git", "hooks", "commit-msg");
    writeFileSync(
      hook,
      '#!/bin/sh\nhead -1 "$1" | grep -Eq "^(feat|fix|chore): " || { echo "✖ subject must be conventional"; exit 1; }\n',
    );
    chmodSync(hook, 0o755);
    expect(await localRunner.checkCommitMessage(dir, "feat: add a footer")).toEqual({
      passed: true,
      output: "",
    });
    const rejected = await localRunner.checkCommitMessage(dir, "Add a footer");
    expect(rejected?.passed).toBe(false);
    expect(rejected?.output).toContain("subject must be conventional");
  });
});

describe("archiveWorkspace", () => {
  it("commits unfinished work to the branch, keeps the memory, removes the worktree", async () => {
    const dir = repo();
    const tree = path.join(mkdtempSync(path.join(tmpdir(), "yugotool-archive-")), "wt");
    git(dir, "worktree", "add", "-q", "-b", "yugotool/task-1", tree);
    writeFileSync(path.join(tree, "a.txt"), "half done\n");
    writeFileSync(path.join(tree, "new.txt"), "draft\n");
    // A pre-commit hook must not block the snapshot.
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    mkdirSync(path.join(tree, ".yugotool"));
    writeFileSync(path.join(tree, ".yugotool", "progress.md"), "step 2\n");
    writeFileSync(path.join(dir, ".git", "info", "exclude"), ".yugotool/\n");
    const memoryDir = path.join(mkdtempSync(path.join(tmpdir(), "yugotool-mem-")), "memory");

    const snapshot = await localRunner.archiveWorkspace({
      repoPath: dir,
      worktreePath: tree,
      memoryDir,
      message: "wip: unfinished",
    });

    expect(snapshot).toMatch(/^[0-9a-f]{7,}$/);
    expect(existsSync(tree)).toBe(false);
    expect(git(dir, "worktree", "list")).not.toContain(tree);
    expect(git(dir, "show", "yugotool/task-1:a.txt")).toBe("half done");
    expect(git(dir, "show", "yugotool/task-1:new.txt")).toBe("draft");
    expect(git(dir, "log", "-1", "--format=%s", "yugotool/task-1")).toBe("wip: unfinished");
    expect(readFileSync(path.join(memoryDir, "progress.md"), "utf8")).toBe("step 2\n");
  });

  it("removes a clean worktree without a commit", async () => {
    const dir = repo();
    const tree = path.join(mkdtempSync(path.join(tmpdir(), "yugotool-archive-")), "wt");
    git(dir, "worktree", "add", "-q", "-b", "yugotool/task-2", tree);
    const head = git(dir, "rev-parse", "yugotool/task-2");
    const memoryDir = path.join(tree, "..", "memory");
    expect(
      await localRunner.archiveWorkspace({
        repoPath: dir,
        worktreePath: tree,
        memoryDir,
        message: "x",
      }),
    ).toBeNull();
    expect(existsSync(tree)).toBe(false);
    expect(git(dir, "rev-parse", "yugotool/task-2")).toBe(head);
  });
});

describe("index.lock held by another git", () => {
  it("waits for the lock instead of failing the commit", async () => {
    const dir = repo();
    const tree = path.join(mkdtempSync(path.join(tmpdir(), "yugotool-lock-")), "wt");
    git(dir, "worktree", "add", "-q", "-b", "yugotool/task-lock", tree);
    writeFileSync(path.join(tree, "a.txt"), "changed\n");
    // Another process (the API's diff, an editor) holds the worktree's index for a moment.
    const lock = git(tree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
    writeFileSync(lock, "");
    setTimeout(() => rmSync(lock), 400);

    expect(await localRunner.checkpoint(tree, "wip: locked")).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(dir, "show", "yugotool/task-lock:a.txt")).toBe("changed");
  });
});
