import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `origin/<base>` when the repo has it, else the local base branch (as the worker does). */
export async function baseRef(repo: string, baseBranch: string): Promise<string> {
  const remoteBase = `origin/${baseBranch}`;
  return exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", remoteBase]).then(
    () => remoteBase,
    () => baseBranch,
  );
}

/**
 * Cache key of a route map: the git blob ids of its source files at `ref`.
 * Must match the worker's `routeSourceHash` (apps/worker/src/runner/route-map.ts).
 */
export async function routeSourceHash(repo: string, ref: string, files: string[]): Promise<string> {
  const lines = await Promise.all(
    files.toSorted().map(async (file) => {
      const blob = await exec("git", [
        "-C",
        repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}:${file}`,
      ])
        .then(({ stdout }) => stdout.trim())
        .catch(() => "missing");
      return `${file}\0${blob}\n`;
    }),
  );
  return createHash("sha256").update(lines.join("")).digest("hex");
}
