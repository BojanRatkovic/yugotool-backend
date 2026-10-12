import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CappedOutput {
  text: string;
  truncated: boolean;
}

/**
 * Runs `git <args>` and keeps at most `maxChars` of stdout. Once the cap is hit
 * the process is killed, so output size never fails the call (unlike execFile's
 * maxBuffer) and a huge diff costs only what we keep.
 *
 * Optional locks are off: the API only reads, and a `git diff` that refreshes
 * the index takes `index.lock`, which fails the worker's `git add` at delivery.
 */
export function gitCapped(
  cwd: string,
  args: string[],
  maxChars: number,
  env: NodeJS.ProcessEnv = {},
): Promise<CappedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    });
    let text = "";
    let truncated = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      text += chunk;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, ""); // no split surrogate pair
        truncated = true;
        child.stdout.destroy();
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 10_000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (truncated || code === 0) resolve({ text, truncated });
      else reject(new Error(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

import type { DiffFile } from "@yugotool/contracts";

export interface DiffLimits {
  patchChars: number;
  /** Cap for the `--numstat` / `--name-status` listings: kilobytes, even for thousands of files. */
  listChars: number;
}

export interface Diff {
  files: DiffFile[];
  patch: string;
  truncated: boolean;
}

const STATUS: Record<string, DiffFile["status"]> = {
  A: "added",
  D: "deleted",
  R: "renamed",
};

/** `git diff -z -M --name-status` → status by (new) path. A rename/copy is `R<score>\0old\0new`. */
function parseNameStatus(nameStatus: string): Map<string, DiffFile["status"]> {
  const statuses = new Map<string, DiffFile["status"]>();
  const names = nameStatus.split("\0");
  for (let i = 0; i + 1 < names.length;) {
    const code = names[i] ?? "";
    const renamed = code.startsWith("R") || code.startsWith("C");
    const target = names[renamed ? i + 2 : i + 1] ?? "";
    statuses.set(target, STATUS[code.charAt(0)] ?? "modified");
    i += renamed ? 3 : 2;
  }
  return statuses;
}

const count = (n: string) => (n === "-" ? 0 : Number(n));

/**
 * `git diff -z --numstat` and `-z --name-status` (both with `-M`) → files.
 * Pure. A rename is `R<score>\0old\0new` in the one and `a\td\t\0old\0new` in
 * the other; a binary file counts `-\t-`.
 */
export function parseDiffFiles(numstat: string, nameStatus: string): DiffFile[] {
  const statuses = parseNameStatus(nameStatus);
  const files: DiffFile[] = [];
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length;) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i] ?? "");
    if (match === null) {
      i += 1;
      continue;
    }
    const [, added = "-", deleted = "-", inline = ""] = match;
    // A rename leaves the path empty and puts old and new in the next two fields.
    const renamed = inline === "";
    const filePath = renamed ? (fields[i + 2] ?? "") : inline;
    files.push({
      path: filePath,
      oldPath: renamed ? (fields[i + 1] ?? "") : null,
      status: statuses.get(filePath) ?? (renamed ? "renamed" : "modified"),
      additions: count(added),
      deletions: count(deleted),
      binary: added === "-" && deleted === "-",
    });
    i += renamed ? 3 : 1;
  }
  return files;
}

/**
 * What the run's changes are measured from: the merge-base with
 * `origin/<base>` when the repo has it (worktrees start there), else with the
 * local base. Diffing against the local branch directly showed every commit
 * the local base is behind (or ahead) as a change of the run.
 */
async function diffBase(cwd: string, baseBranch: string, head = "HEAD"): Promise<string> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const mergeBase = await gitCapped(cwd, ["merge-base", head, ref], 200).then(
      (out) => out.text.trim(),
      () => "",
    );
    if (mergeBase) return mergeBase;
  }
  return baseBranch;
}

/** The file list and the patch of `git diff <range>`; the list is never cut. */
async function diffOf(
  cwd: string,
  range: string[],
  limits: DiffLimits,
  env: NodeJS.ProcessEnv = {},
): Promise<Diff> {
  const flags = ["-M", "--no-color", "--no-ext-diff"];
  const [numstat, nameStatus, patch] = await Promise.all([
    gitCapped(cwd, ["diff", ...flags, "-z", "--numstat", ...range], limits.listChars, env),
    gitCapped(cwd, ["diff", ...flags, "-z", "--name-status", ...range], limits.listChars, env),
    gitCapped(cwd, ["diff", ...flags, ...range], limits.patchChars, env),
  ]);
  return {
    files: parseDiffFiles(numstat.text, nameStatus.text),
    patch: patch.text,
    truncated: patch.truncated,
  };
}

/**
 * Worktree vs the merge-base with its base: committed and uncommitted changes, new files included.
 * New files are marked intent-to-add on a copy of the index, never the worktree's own: the run
 * (and its delivery `git add`) owns that index and its lock.
 */
export async function worktreeDiff(
  cwd: string,
  baseBranch: string,
  limits: DiffLimits,
): Promise<Diff> {
  const index = (
    await gitCapped(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"], 4_096)
  ).text.trim();
  const scratch = await mkdtemp(path.join(tmpdir(), "yugotool-diff-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    await copyFile(index, env.GIT_INDEX_FILE).catch(() => undefined); // none yet: git starts empty
    await gitCapped(cwd, ["add", "--intent-to-add", "."], 10_000, env);
    return await diffOf(cwd, [await diffBase(cwd, baseBranch)], limits, env);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A finished run's changes, read from its branch in the repo once the worktree
 * is gone (unfinished work was committed to the branch before removal).
 */
export async function branchDiff(
  repoPath: string,
  branch: string,
  baseBranch: string,
  limits: DiffLimits,
): Promise<Diff> {
  return diffOf(repoPath, [await diffBase(repoPath, baseBranch, branch), branch], limits);
}
