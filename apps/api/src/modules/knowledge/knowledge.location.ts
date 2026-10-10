import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnowledgeSourceKind } from "@zastava/contracts";

/** `~/x` → absolute; everything else resolved as given. Pure but for the home dir. */
export function expandHome(location: string): string {
  if (location === "~") return os.homedir();
  if (location.startsWith("~/")) return path.join(os.homedir(), location.slice(2));
  return path.resolve(location);
}

/**
 * Why a location can't work for its kind, or null. Local kinds must exist on
 * this machine (git_local: with a `.git`); a remote must look like a git URL.
 * Reachability of a remote is checked by the sync that follows.
 */
export function locationProblem(kind: KnowledgeSourceKind, location: string): string | null {
  if (kind === "git_remote") {
    return /^(https:\/\/|git@|ssh:\/\/)\S+$/.test(location)
      ? null
      : "Use a git URL: https://github.com/org/repo or git@github.com:org/repo.git.";
  }
  const resolved = expandHome(location);
  if (!existsSync(resolved)) return `${resolved} does not exist on this machine.`;
  if (kind === "git_local" && !existsSync(path.join(resolved, ".git"))) {
    return `${resolved} is not a Git repository. Use "Folder or file" for plain folders.`;
  }
  return null;
}
