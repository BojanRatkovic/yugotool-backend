import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Written by the worker (screenshots, preview tests); the API only reads. */
export const ARTIFACTS_ROOT = path.join(os.homedir(), ".zastava", "artifacts");

/** Run worktrees, created by the worker; removed with their project. */
export const WORKTREES_ROOT = path.join(os.homedir(), ".zastava", "worktrees");

export const runArtifactsDir = (runId: string): string => path.join(ARTIFACTS_ROOT, runId);
export const previewTestDir = (projectId: string): string =>
  path.join(ARTIFACTS_ROOT, "preview", projectId);
/** Same files as the worker's runner/artifacts.ts: saved session, sign-in progress, Done/Cancel. */
export const previewSessionFile = (projectId: string): string =>
  path.join(previewTestDir(projectId), "session.json");
export const previewSignInFile = (projectId: string): string =>
  path.join(previewTestDir(projectId), "sign-in.json");
export const previewSignInFinishFile = (projectId: string): string =>
  path.join(previewTestDir(projectId), "sign-in-finish.json");

const inside = (p: string, base: string): boolean =>
  p === base || p.startsWith(`${base}${path.sep}`);

/**
 * Resolves `relative` inside `root`, or null when it escapes it — by `..`, an
 * absolute path, or a symlink pointing out. Missing files resolve to null too.
 */
export async function resolveInside(root: string, relative: string): Promise<string | null> {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
  const candidate = path.resolve(root, relative);
  if (!inside(candidate, path.resolve(root))) return null;
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(candidate)]);
    return inside(real, realRoot) && real !== realRoot ? real : null;
  } catch {
    return null;
  }
}
