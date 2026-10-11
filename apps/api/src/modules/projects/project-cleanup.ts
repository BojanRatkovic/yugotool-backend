import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { previewTestDir, runArtifactsDir, WORKTREES_ROOT } from "../../core/artifacts/artifacts";
import { hubOfRepo } from "./work-hub";

const exec = promisify(execFile);

/**
 * Removes what a deleted project left on disk: its runs' files (see
 * `removeRunFiles`) and the preview test. Best effort: returns what failed.
 */
export async function removeProjectFiles(input: {
  projectId: string;
  /** `hub`: `repoPath` is the hub and each run's worktree belongs to `repos/<repo>` (spec 0014). */
  kind?: "repo" | "hub";
  repoPath: string;
  worktrees: { runId: string; worktreePath: string; repo?: string | null }[];
  runIds: string[];
}): Promise<string[]> {
  const failed = await removeRunFiles(input);
  const preview = previewTestDir(input.projectId);
  await rm(preview, { recursive: true, force: true }).catch(() => failed.push(preview));
  return failed;
}

/**
 * Removes runs' worktrees (only under ~/.yugotool/worktrees or the work hub's
 * worktrees/, unregistered from their repo) and their artifacts. Branches in
 * the repo are kept. Best effort: returns what failed.
 */
export async function removeRunFiles(input: {
  /** `hub`: `repoPath` is the hub and each run's worktree belongs to `repos/<repo>` (spec 0014). */
  kind?: "repo" | "hub";
  repoPath: string;
  worktrees: { runId: string; worktreePath: string; repo?: string | null }[];
  runIds: string[];
}): Promise<string[]> {
  const failed: string[] = [];
  const hub = input.kind === "hub" ? input.repoPath : hubOfRepo(input.repoPath);
  const roots = [WORKTREES_ROOT, ...(hub ? [path.join(hub, "worktrees")] : [])].map((r) =>
    path.resolve(r),
  );
  const gitDirOf = (repo: string | null | undefined): string =>
    input.kind === "hub" && repo ? path.join(input.repoPath, "repos", repo) : input.repoPath;
  const pruned = new Set<string>();
  for (const { worktreePath, repo } of input.worktrees) {
    const target = path.resolve(worktreePath);
    if (!roots.some((root) => target.startsWith(`${root}${path.sep}`))) continue;
    const gitDir = gitDirOf(repo);
    await exec("git", ["-C", gitDir, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    await rm(target, { recursive: true, force: true }).catch(() => failed.push(target));
    pruned.add(gitDir);
  }
  for (const gitDir of input.kind === "hub" ? pruned : [input.repoPath]) {
    await exec("git", ["-C", gitDir, "worktree", "prune"]).catch(() => undefined);
  }
  for (const dir of input.runIds.map(runArtifactsDir)) {
    await rm(dir, { recursive: true, force: true }).catch(() => failed.push(dir));
  }
  return failed;
}
