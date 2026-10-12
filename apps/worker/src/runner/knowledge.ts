import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { KnowledgeMount, KnowledgeSourceKind } from "@yugotool/contracts";
import { yugotoolHome } from "./home";

const exec = promisify(execFile);

/** Snapshots live outside every repo; agents get read access to one per source. */
const KNOWLEDGE_ROOT = path.join(yugotoolHome(), "knowledge");

/** Snapshots kept per source: the current one and a couple that runs may still read. */
const KEEP_SNAPSHOTS = 3;

/** Tried in order when a source names no entry file. */
const ENTRY_CANDIDATES = ["INDEX.md", "README.md", "AGENTS.md", "CLAUDE.md"];

export interface KnowledgeSourceInput {
  id: string;
  name: string;
  kind: KnowledgeSourceKind;
  location: string;
  branch: string | null;
  entryFile: string | null;
  excludes: string[];
}

/** `~/x` → absolute; everything else resolved as given. */
function expandHome(location: string): string {
  if (location === "~") return os.homedir();
  if (location.startsWith("~/")) return path.join(os.homedir(), location.slice(2));
  return path.resolve(location);
}

/** Whether a file or folder name matches an exclude pattern (`*` = any run of characters). Pure. */
export function isExcluded(name: string, excludes: string[]): boolean {
  return excludes.some((pattern) => {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${source}$`).test(name);
  });
}

/** The named entry file when it exists, else the first usual suspect, else the first root .md. */
async function resolveEntryFile(dir: string, wanted: string | null): Promise<string | null> {
  if (wanted && existsSync(path.join(dir, wanted))) return wanted;
  for (const candidate of ENTRY_CANDIDATES) {
    if (existsSync(path.join(dir, candidate))) return candidate;
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.toSorted().find((name) => name.toLowerCase().endsWith(".md")) ?? null;
}

/**
 * Brings a source up to date and returns the read-only folder a run uses.
 * Git sources: tracked files only, at the branch head (gitignored secrets
 * never land in the snapshot). Path sources: a fresh copy minus `excludes`.
 */
export async function syncKnowledgeSource(
  source: KnowledgeSourceInput,
  root: string = KNOWLEDGE_ROOT,
): Promise<KnowledgeMount> {
  const home = path.join(root, source.id);
  await mkdir(home, { recursive: true });
  const { dir, sha } =
    source.kind === "path" ? await copyPath(source, home) : await snapshotGit(source, home);
  return {
    name: source.name,
    dir,
    sha,
    entryFile: await resolveEntryFile(dir, source.entryFile),
  };
}

async function snapshotGit(
  source: KnowledgeSourceInput,
  home: string,
): Promise<{ dir: string; sha: string }> {
  const repo =
    source.kind === "git_remote" ? await fetchRemote(source, home) : expandHome(source.location);
  if (source.kind === "git_local" && !existsSync(path.join(repo, ".git"))) {
    throw new Error(`${repo} is not a git repository`);
  }
  const ref = source.branch ?? "HEAD";
  const { stdout } = await exec("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = stdout.trim();
  const dir = path.join(home, sha);
  if (!existsSync(dir)) {
    // Extract next to the target, then rename: a run never sees a half-written snapshot.
    const partial = `${dir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    const tarball = path.join(home, `${sha}.tar`);
    await exec("git", ["-C", repo, "archive", "--format=tar", "-o", tarball, sha]);
    await exec("tar", ["-xf", tarball, "-C", partial]);
    await rm(tarball, { force: true });
    await rename(partial, dir);
  }
  await pruneSnapshots(home, dir);
  return { dir, sha };
}

/** A bare mirror of the remote under the source's folder, fetched on every sync. */
async function fetchRemote(source: KnowledgeSourceInput, home: string): Promise<string> {
  const repo = path.join(home, "repo.git");
  if (!existsSync(repo)) {
    await exec("git", ["clone", "--bare", "--quiet", source.location, repo], {
      timeout: 10 * 60_000,
    });
  } else {
    await exec(
      "git",
      ["-C", repo, "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/heads/*"],
      { timeout: 10 * 60_000 },
    );
  }
  return repo;
}

/** Keeps the newest few snapshot folders (runs in flight may still read one). */
async function pruneSnapshots(home: string, current: string): Promise<void> {
  const entries = await readdir(home, { withFileTypes: true });
  const snapshots = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && /^[0-9a-f]{40,64}$/.test(e.name))
      .map(async (e) => {
        const full = path.join(home, e.name);
        return { full, mtime: (await stat(full)).mtimeMs };
      }),
  );
  const stale = snapshots
    .filter((s) => s.full !== current)
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(KEEP_SNAPSHOTS - 1);
  await Promise.all(stale.map((s) => rm(s.full, { recursive: true, force: true })));
}

async function copyPath(
  source: KnowledgeSourceInput,
  home: string,
): Promise<{ dir: string; sha: null }> {
  const from = expandHome(source.location);
  const info = await stat(from).catch(() => null);
  if (!info) throw new Error(`${from} does not exist`);
  const dir = path.join(home, "files");
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  if (info.isFile()) await copyFile(from, path.join(partial, path.basename(from)));
  else await copyTree(from, partial, source.excludes);
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
  return { dir, sha: null };
}

/** Recursive copy of files and folders, skipping excluded names, symlinks and `.git`. */
async function copyTree(from: string, to: string, excludes: string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === ".git" || isExcluded(entry.name, excludes)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest, excludes);
    else if (entry.isFile()) await copyFile(src, dest);
  }
}
