import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SIGNATURE } from "./pr-body";

const exec = promisify(execFile);

/** Where worktrees live: outside the repo so the user's checkout is never touched. */
const WORKTREES_ROOT = path.join(os.homedir(), ".zastava", "worktrees");

export interface Workspace {
  path: string;
  branch: string;
}

/**
 * The local runner: one git worktree per run, on a fresh branch off the
 * project's base branch. A future CloudRunner implements the same shape
 * against a sandbox.
 */
export const localRunner = {
  async prepareWorkspace(input: {
    repoPath: string;
    baseBranch: string;
    runId: string;
    title: string;
  }): Promise<Workspace> {
    await mkdir(WORKTREES_ROOT, { recursive: true });
    const worktreePath = path.join(WORKTREES_ROOT, input.runId);
    const branch = `zastava/${slugify(input.title)}-${input.runId.slice(0, 8)}`;
    // Start where the PR will land: origin/<base> when there is one (the local base can be stale).
    const start = await localRunner.baseRef(input.repoPath, input.baseBranch);
    await exec("git", [
      "-C",
      input.repoPath,
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      worktreePath,
      start,
    ]);
    return { path: worktreePath, branch };
  },

  /** The diff the reviewers see, base...worktree including uncommitted changes. */
  async diffStat(worktreePath: string): Promise<string> {
    await exec("git", ["-C", worktreePath, "add", "-N", "."]);
    const { stdout } = await exec("git", ["-C", worktreePath, "diff", "--stat"]);
    return stdout.trim();
  },

  /** Stat of the worktree (uncommitted and new files included) against the base branch. */
  async diffStatAgainst(worktreePath: string, baseBranch: string): Promise<string> {
    const git = (...args: string[]) =>
      exec("git", ["-C", worktreePath, ...args], { maxBuffer: 10 * 1024 * 1024 });
    // Compare with what the PR will be compared with: the remote base when there is one,
    // from the merge-base, so commits that only moved the local base don't show up.
    const remoteBase = `origin/${baseBranch}`;
    const hasRemote = await git("rev-parse", "--verify", "--quiet", remoteBase).then(
      () => true,
      () => false,
    );
    const { stdout: mergeBase } = await git(
      "merge-base",
      hasRemote ? remoteBase : baseBranch,
      "HEAD",
    );
    await git("add", "-N", ".");
    const { stdout } = await git("diff", "--stat=100", mergeBase.trim());
    return stdout;
  },

  /** `origin/<base>` when the repo has it, else the local base branch. */
  async baseRef(repoOrWorktree: string, baseBranch: string): Promise<string> {
    const remoteBase = `origin/${baseBranch}`;
    return exec("git", ["-C", repoOrWorktree, "rev-parse", "--verify", "--quiet", remoteBase]).then(
      () => remoteBase,
      () => baseBranch,
    );
  },

  /**
   * Where the PR starts: merge-base of `origin/<base>` (or the local base when
   * there is no remote) and HEAD. The local base can be stale; the remote is what the PR targets.
   */
  async mergeBase(worktreePath: string, baseBranch: string): Promise<string> {
    const ref = await localRunner.baseRef(worktreePath, baseBranch);
    const { stdout } = await exec("git", ["-C", worktreePath, "merge-base", ref, "HEAD"]);
    return stdout.trim();
  },

  /** Files changed since `sha`, committed or not, new files included. */
  async changedFiles(worktreePath: string, sha: string): Promise<string[]> {
    const git = (...args: string[]) =>
      exec("git", ["-C", worktreePath, ...args], { maxBuffer: 10 * 1024 * 1024 });
    await git("add", "-N", ".");
    const { stdout } = await git("diff", "--name-only", sha);
    return stdout.split("\n").filter(Boolean);
  },

  /** Unified diff of the worktree (incl. new files) against `sha`, lockfiles left out. */
  async diffAgainst(worktreePath: string, sha: string): Promise<string> {
    const git = (...args: string[]) =>
      exec("git", ["-C", worktreePath, ...args], { maxBuffer: 50 * 1024 * 1024 });
    await git("add", "-N", ".");
    const { stdout } = await git(
      "diff",
      "--unified=3",
      sha,
      "--",
      ".",
      ":(exclude)**/package-lock.json",
      ":(exclude)**/pnpm-lock.yaml",
      ":(exclude)**/yarn.lock",
    );
    return stdout;
  },

  /**
   * Restores lockfiles an agent changed without changing any package.json
   * (a stray `npm install` on another Node/npm version rewrites the lock and
   * breaks `npm ci`). Returns the files restored to `baseSha`.
   */
  async revertIncidentalLockfiles(worktreePath: string, baseSha: string): Promise<string[]> {
    const changed = await localRunner.changedFiles(worktreePath, baseSha);
    const reverted = incidentalLockfiles(changed);
    for (const file of reverted) {
      await exec("git", ["-C", worktreePath, "checkout", baseSha, "--", file]).catch(() =>
        // A lockfile that is new in this run: remove it instead.
        rm(path.join(worktreePath, file), { force: true }),
      );
    }
    return reverted;
  },

  /** A detached, read-only-by-convention worktree at `ref` (QA base previews, preview tests). */
  async addDetachedWorktree(repoOrWorktree: string, ref: string, name: string): Promise<string> {
    await mkdir(WORKTREES_ROOT, { recursive: true });
    const target = path.join(WORKTREES_ROOT, name);
    await exec("git", ["-C", repoOrWorktree, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    await exec("git", [
      "-C",
      repoOrWorktree,
      "worktree",
      "add",
      "--detach",
      "--force",
      target,
      ref,
    ]);
    return target;
  },

  async removeWorktree(repoOrWorktree: string, target: string): Promise<void> {
    await exec("git", ["-C", repoOrWorktree, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    await rm(target, { recursive: true, force: true });
    await exec("git", ["-C", repoOrWorktree, "worktree", "prune"]).catch(() => undefined);
  },

  async headSha(worktreePath: string): Promise<string> {
    const { stdout } = await exec("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
    return stdout.trim();
  },

  async commitsSince(worktreePath: string, sha: string): Promise<number> {
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "rev-list",
      "--count",
      `${sha}..HEAD`,
    ]);
    return Number(stdout.trim()) || 0;
  },

  /**
   * Turns commits made after `sha` back into working-tree changes (mixed
   * reset), so they reach the preflight hook and the delivery commit. Returns
   * how many commits were undone.
   */
  async uncommitSince(worktreePath: string, sha: string): Promise<number> {
    const count = await localRunner.commitsSince(worktreePath, sha);
    if (count > 0) await exec("git", ["-C", worktreePath, "reset", "--mixed", sha]);
    return count;
  },

  /** Untracked, non-ignored files in the worktree (paths relative to it). */
  async untrackedFiles(worktreePath: string): Promise<string[]> {
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    return stdout.split("\n").filter(Boolean);
  },

  /**
   * Moves files that appeared in the worktree after `before` into `dir`
   * (keeping their names flat). Returns the moved paths.
   */
  async moveNewUntracked(worktreePath: string, before: string[], dir: string): Promise<string[]> {
    const known = new Set(before);
    const strays = (await localRunner.untrackedFiles(worktreePath)).filter((f) => !known.has(f));
    for (const file of strays) {
      const from = path.join(worktreePath, file);
      const to = path.join(dir, path.basename(file));
      await rename(from, to).catch(() => rm(from, { force: true }));
    }
    return strays;
  },

  async recentLog(worktreePath: string): Promise<string> {
    const { stdout } = await exec("git", ["-C", worktreePath, "log", "--oneline", "-10"]);
    return stdout.trim();
  },

  /** Commits everything (`.zastava/` is excluded); null when there was nothing to commit. */
  async checkpoint(worktreePath: string, message: string): Promise<string | null> {
    const git = (...args: string[]) => exec("git", ["-C", worktreePath, ...args]);
    await git("add", "-A");
    const { stdout: staged } = await git("diff", "--cached", "--name-only");
    if (!staged.trim()) return null;
    await git("commit", "-m", message);
    const { stdout } = await git("rev-parse", "--short", "HEAD");
    return stdout.trim();
  },

  /** Runs a shell command, killing it after 15 min; output is stdout+stderr interleaved. */
  runCommand(
    cwd: string,
    command: string,
    onProgress: () => void,
    options: { ci?: boolean } = {},
  ): Promise<{ passed: boolean; output: string }> {
    return new Promise((resolve) => {
      const env = options.ci === false ? process.env : { ...process.env, CI: "1" };
      const child = spawn(command, { cwd, shell: true, env });
      let output = "";
      const append = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-200_000);
        onProgress();
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      const heartbeat = setInterval(onProgress, 20_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        resolve({ passed: code === 0, output });
      });
    });
  },

  /**
   * The repo's `commit-msg` hook (commitlint, Conventional Commits…) over the
   * message delivery will commit with. Null when there is no such hook.
   */
  async checkCommitMessage(
    worktreePath: string,
    title: string,
  ): Promise<{ passed: boolean; output: string } | null> {
    const git = (...args: string[]) => exec("git", ["-C", worktreePath, ...args]);
    const { stdout } = await git(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/commit-msg",
    );
    const hook = stdout.trim();
    const executable = await access(hook, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (!executable) return null;
    const { stdout: gitDir } = await git("rev-parse", "--absolute-git-dir");
    const file = path.join(gitDir.trim(), "ZASTAVA_COMMIT_MSG");
    await writeFile(file, `${title}\n\n${SIGNATURE}.\n`);
    try {
      await git("hook", "run", "commit-msg", "--", file);
      return { passed: true, output: "" };
    } catch (error) {
      const out = (key: "stdout" | "stderr"): string =>
        error instanceof Object && key in error ? String(Reflect.get(error, key)) : "";
      return { passed: false, output: `${out("stdout")}${out("stderr")}`.trim() };
    } finally {
      await rm(file, { force: true });
    }
  },

  /**
   * The repo's own `pre-commit` hook (lefthook, husky, pre-commit, …) over
   * everything the run changed, staged as delivery will stage it. Null when the
   * repo has no such hook installed.
   */
  async runPreCommitHook(
    worktreePath: string,
    onProgress: () => void,
    /** Called once a hook is found, before it runs. */
    onStart: () => Promise<void> = async () => undefined,
  ): Promise<{ passed: boolean; output: string } | null> {
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/pre-commit",
    ]);
    const hook = stdout.trim();
    const executable = await access(hook, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (!executable) return null;
    await onStart();
    await exec("git", ["-C", worktreePath, "add", "-A"]);
    // Like `git commit` runs it: no CI env, so hooks behave as they do for a person.
    return localRunner.runCommand(worktreePath, "git hook run pre-commit", onProgress, {
      ci: false,
    });
  },

  async deliver(input: {
    worktreePath: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    /** Commit only: never push or open a PR. */
    localOnly?: boolean;
    /** Open the pull request as a draft. */
    draft?: boolean;
  }): Promise<{ prUrl: string | null; summary: string }> {
    const git = (...args: string[]) => exec("git", ["-C", input.worktreePath, ...args]);
    await git("add", "-A");
    const { stdout: staged } = await git("diff", "--cached", "--name-only");
    if (staged.trim()) await git("commit", "-m", input.title, "-m", `${SIGNATURE}.`);
    if (input.localOnly) {
      return {
        prUrl: null,
        summary: `Committed on ${input.branch} (local only: nothing pushed, no PR).`,
      };
    }
    return localRunner.openPullRequest({ ...input, dir: input.worktreePath });
  },

  /**
   * Pushes `branch` and opens a PR for it with gh. `dir` is the run's worktree
   * or, once that is gone, the repo (they share refs). A PR that already exists
   * for the branch counts as opened.
   */
  async openPullRequest(input: {
    dir: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ prUrl: string | null; summary: string; reason?: string }> {
    const git = (...args: string[]) => exec("git", ["-C", input.dir, ...args]);
    const { stdout: remotes } = await git("remote");
    if (!remotes.split("\n").includes("origin")) {
      return {
        prUrl: null,
        summary: `Committed on ${input.branch} (no origin remote, no PR).`,
        reason: "This repo has no origin remote to push to.",
      };
    }
    await git("push", "-u", "origin", input.branch);
    // gh only opens PRs on GitHub; any other origin (GitLab, a bare repo) stops at the push.
    const { stdout: originUrl } = await git("remote", "get-url", "origin");
    if (!/github\.com[:/]/.test(originUrl)) {
      return {
        prUrl: null,
        summary: `Pushed ${input.branch} to origin (${originUrl.trim()}); not a GitHub remote, so no PR.`,
        reason: `Pushed ${input.branch}, but origin is not on GitHub, so ZASTAVA can't open the pull request.`,
      };
    }
    const kind = input.draft ? "Draft pull request" : "Pull request";
    try {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "create",
          "--title",
          input.title,
          "--body",
          input.body,
          "--head",
          input.branch,
          "--base",
          input.baseBranch,
          ...(input.draft ? ["--draft"] : []),
        ],
        { cwd: input.dir },
      );
      const prUrl = stdout.trim().split("\n").pop() ?? null;
      return { prUrl, summary: `${kind} opened: ${prUrl}` };
    } catch (error) {
      const existing = existingPrUrl(error);
      if (!existing) throw error;
      return {
        prUrl: existing,
        summary: `A pull request for ${input.branch} already exists: ${existing}`,
      };
    }
  },
};

/** gh's "a pull request for branch … already exists: <url>" → the url. Pure. */
export function existingPrUrl(error: unknown): string | null {
  const text =
    error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : String(error);
  return /already exists:?\s*(https:\/\/\S+\/pull\/\d+)/.exec(text)?.[1] ?? null;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

/** Changed lockfiles, when no package.json changed with them (then they are incidental). */
export function incidentalLockfiles(changed: string[]): string[] {
  if (changed.some((file) => fileName(file) === "package.json")) return [];
  return changed.filter((file) => LOCKFILES.has(fileName(file)));
}

const fileName = (file: string): string => file.split("/").pop() ?? file;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "work-order"
  );
}
