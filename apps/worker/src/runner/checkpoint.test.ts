import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hookMissingDependencies, localRunner } from "./local-runner";

const dir = mkdtempSync(path.join(os.tmpdir(), "yugotool-checkpoint-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

describe("checkpoint", () => {
  it("commits even when the repo's pre-commit hook refuses (overcommit in a fresh worktree)", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'run overcommit --sign' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(dir, "a.rb"), "# doc\n");
    expect(await localRunner.checkpoint(dir, "yugotool: shift 1")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("hook failures from missing dependencies", () => {
  it("tells them apart from real hook failures", () => {
    expect(
      hookMissingDependencies(
        "Could not find yard-0.9.45 in locally installed gems (Bundler::GemNotFound)",
      ),
    ).toBe(true);
    expect(hookMissingDependencies("Error: Cannot find module 'eslint'")).toBe(true);
    expect(hookMissingDependencies("app/a.rb:3:1: C: Layout/IndentationWidth")).toBe(false);
  });
});
