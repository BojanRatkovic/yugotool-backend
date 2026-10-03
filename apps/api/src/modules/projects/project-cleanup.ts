import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { previewTestDir, runArtifactsDir, WORKTREES_ROOT } from "../../core/artifacts/artifacts";

const exec = promisify(execFile);

/**
 * Removes what a deleted project left on disk: its runs' worktrees (only under
 * ~/.zastava/worktrees, unregistered from the repo), run artifacts and the
 * preview test. Branches in the repo are kept. Best effort: returns what failed.
 */
export async function removeProjectFiles(input: {
  projectId: string;
  repoPath: string;
  worktrees: { runId: string; worktreePath: string }[];
  runIds: string[];
}): Promise<string[]> {
  const failed: string[] = [];
  const root = path.resolve(WORKTREES_ROOT);
  for (const { worktreePath } of input.worktrees) {
    const target = path.resolve(worktreePath);
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    await exec("git", ["-C", input.repoPath, "worktree", "remove", "--force", target]).catch(
      () => undefined,
    );
    await rm(target, { recursive: true, force: true }).catch(() => failed.push(target));
  }
  await exec("git", ["-C", input.repoPath, "worktree", "prune"]).catch(() => undefined);
  for (const dir of [...input.runIds.map(runArtifactsDir), previewTestDir(input.projectId)]) {
    await rm(dir, { recursive: true, force: true }).catch(() => failed.push(dir));
  }
  return failed;
}
