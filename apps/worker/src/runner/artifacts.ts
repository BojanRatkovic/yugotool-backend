import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Screenshots and other run outputs; never inside a worktree, never committed. */
export const ARTIFACTS_ROOT = path.join(os.homedir(), ".yugotool", "artifacts");

export function runArtifactsDir(runId: string): string {
  return path.join(ARTIFACTS_ROOT, runId);
}

/** Last preview test of a project: result.json + screenshot.png. */
export function previewTestDir(projectId: string): string {
  return path.join(ARTIFACTS_ROOT, "preview", projectId);
}

/** The project's saved sign-in (Playwright storage state; cookies, so 0600). */
export function previewSessionFile(projectId: string): string {
  return path.join(previewTestDir(projectId), "session.json");
}

/** Progress of the interactive sign-in, read by the API. */
export function previewSignInFile(projectId: string): string {
  return path.join(previewTestDir(projectId), "sign-in.json");
}

/** Written by the API when the user clicks Done / Cancel in the app. */
export function previewSignInFinishFile(projectId: string): string {
  return path.join(previewTestDir(projectId), "sign-in-finish.json");
}

/** The saved session to start browsers with, or null when the project has none. */
export function existingSession(projectId: string): string | null {
  const file = previewSessionFile(projectId);
  return existsSync(file) ? file : null;
}
