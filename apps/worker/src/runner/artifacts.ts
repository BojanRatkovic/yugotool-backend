import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { yugotoolHome } from "./home";
import {
  parseSavedSession,
  type PreviewPlace,
  retargetSession,
  type StorageState,
} from "./sign-in";

/** Screenshots and other run outputs; never inside a worktree, never committed. */
export const ARTIFACTS_ROOT = path.join(yugotoolHome(), "artifacts");

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

/** Copies of the session moved to one running preview, for browsers that need a file. */
export function previewSessionCopiesDir(projectId: string): string {
  return path.join(previewTestDir(projectId), "sessions");
}

/**
 * The saved session moved to the preview at `place` (see retargetSession),
 * or null when the project has none or the file is unreadable.
 */
export async function sessionFor(
  projectId: string,
  place: PreviewPlace,
): Promise<StorageState | null> {
  const raw = await readFile(previewSessionFile(projectId), "utf8").catch(() => null);
  const saved = raw ? parseSavedSession(raw) : null;
  return saved ? retargetSession(saved, place) : null;
}

/**
 * sessionFor written to a file (0600) for a browser that only takes a path,
 * like the judge's Playwright MCP. Remove it with `rm` once that browser is done.
 */
export async function sessionFileFor(
  projectId: string,
  place: PreviewPlace,
): Promise<string | null> {
  const state = await sessionFor(projectId, place);
  if (!state) return null;
  const dir = previewSessionCopiesDir(projectId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${place.port}.json`);
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  return file;
}

/** Removes a sessionFileFor copy; never throws. */
export async function dropSessionFile(file: string | null): Promise<void> {
  if (file) await rm(file, { force: true }).catch(() => undefined);
}
