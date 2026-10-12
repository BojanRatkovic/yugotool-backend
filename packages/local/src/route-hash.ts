import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Cache key of a route map: the git blob ids of its source files at `ref`.
 * The worker stores it with a discovered map; the API recomputes it to flag a stale one.
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
