import os from "node:os";
import path from "node:path";

/** Screenshots and other run outputs; never inside a worktree, never committed. */
export const ARTIFACTS_ROOT = path.join(os.homedir(), ".zastava", "artifacts");

export function runArtifactsDir(runId: string): string {
  return path.join(ARTIFACTS_ROOT, runId);
}

/** Last preview test of a project: result.json + screenshot.png. */
export function previewTestDir(projectId: string): string {
  return path.join(ARTIFACTS_ROOT, "preview", projectId);
}
