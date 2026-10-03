import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localRunner } from "./local-runner";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zastava-uncommit-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@zastava.local");
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
    const out = mkdtempSync(path.join(tmpdir(), "zastava-artifacts-"));

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
