// Work hubs (spec 0012): which branch a hub repo's work starts from. Hub detection
// itself is shared with the worker in @yugotool/local.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Branches a hub repo's work usually starts from, in order of preference. */
const BASE_CANDIDATES = ["develop", "main", "master"];

/**
 * The branch a repo's work starts from (spec 0014): `origin/HEAD`, else the
 * first of develop → main → master that exists (remote or local), else the
 * checked-out branch, else "main".
 */
export async function detectBaseBranch(repoPath: string): Promise<string> {
  const git = (...args: string[]) =>
    exec("git", ["-C", repoPath, ...args]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
  const originHead = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (originHead.startsWith("origin/")) return originHead.slice("origin/".length);
  for (const name of BASE_CANDIDATES) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (await git("rev-parse", "--verify", "--quiet", ref)) return name;
    }
  }
  return (await git("branch", "--show-current")) || "main";
}
