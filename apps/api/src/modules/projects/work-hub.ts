// Work hubs (spec 0012): `<hub>/repos/<name>` checkouts under a folder whose
// CLAUDE.md/AGENTS.md teaches agents that code. Mirrors apps/worker/src/runner/work-hub.ts.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hubCandidateOf } from "@yugotool/contracts";

const exec = promisify(execFile);

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** A hub root: instructions for agents at the top and a `repos/` folder. */
export function isHubRoot(dir: string): boolean {
  const hasInstructions = ["CLAUDE.md", "AGENTS.md"].some((f) => existsSync(path.join(dir, f)));
  return hasInstructions && isDirectory(path.join(dir, "repos"));
}

/** The hub `repoPath` belongs to, else null. */
export function hubOfRepo(repoPath: string): string | null {
  const hub = hubCandidateOf(path.resolve(repoPath));
  return hub && isHubRoot(hub) ? hub : null;
}

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

/** The git checkouts in a hub's `repos/`, by name. */
export function hubRepos(hub: string): { name: string; path: string }[] {
  const reposDir = path.join(hub, "repos");
  try {
    return readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(reposDir, e.name, ".git")))
      .map((e) => ({ name: e.name, path: path.join(reposDir, e.name) }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
