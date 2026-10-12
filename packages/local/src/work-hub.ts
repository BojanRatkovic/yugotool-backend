// Work hubs (spec 0012): `<hub>/repos/<name>` checkouts under a folder whose
// CLAUDE.md/AGENTS.md teaches agents that code.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { hubCandidateOf } from "@yugotool/contracts";

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** A hub root: instructions for agents at the top and a `repos/` folder. */
export function isHubRoot(dir: string): boolean {
  const hasInstructions = ["CLAUDE.md", "AGENTS.md"].some((f) => existsSync(path.join(dir, f)));
  return hasInstructions && isDirectory(path.join(dir, "repos"));
}

/** The hub `repoPath` belongs to (`<hub>/repos/<name>`), else null. */
export function hubOfRepo(repoPath: string): string | null {
  const hub = hubCandidateOf(path.resolve(repoPath));
  return hub && isHubRoot(hub) ? hub : null;
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
