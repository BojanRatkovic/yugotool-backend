// Work hubs (spec 0012): a folder whose `repos/` holds the code checkouts and
// whose CLAUDE.md/AGENTS.md, knowledge and skills teach agents that code.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hubCandidateOf } from "@zastava/contracts";

const exec = promisify(execFile);

/** Where generated hub plugins live (one per hub, its skills symlinked in). */
const HUB_PLUGINS_ROOT = path.join(os.homedir(), ".zastava", "hub-plugins");

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

/** The git checkouts in a hub's `repos/`, by name (mirrors the API's `hubRepos`). */
export function hubRepoNames(hub: string): string[] {
  const reposDir = path.join(hub, "repos");
  try {
    return readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(reposDir, e.name, ".git")))
      .map((e) => e.name)
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The hub a run's worktree sits in (`<hub>/worktrees/<name>`), else null. */
export function hubOfWorktree(worktreePath: string): string | null {
  const parent = path.dirname(path.resolve(worktreePath));
  if (path.basename(parent) !== "worktrees") return null;
  const hub = path.dirname(parent);
  return isHubRoot(hub) ? hub : null;
}

/** `<hub>/worktrees/<repo>-zastava-<suffix>`, the hub's own naming. Pure. */
export function hubWorktreePath(hub: string, repoPath: string, suffix: string): string {
  return path.join(hub, "worktrees", `${path.basename(repoPath)}-zastava-${suffix}`);
}

const SKIP_IGNORED = /(^|\/)(\.DS_Store|[^/]*\.log|[^/]*\.tsbuildinfo)$/;
const MAX_LINKED = 50;
const MAX_LINKED_BYTES = 256 * 1024;

/**
 * Ignored files worth carrying into a worktree: plain files (no folders like
 * node_modules), not logs, at most 50. Pure over `git ls-files --directory` output.
 */
export function linkableIgnored(entries: string[]): string[] {
  return entries
    .filter((entry) => entry && !entry.endsWith("/") && !SKIP_IGNORED.test(entry))
    .slice(0, MAX_LINKED);
}

/**
 * Worktrees share `.git` but not gitignored files (`.env`, `config/application.yml`):
 * symlink them from the source checkout, as the hub's own recipe does, so the
 * app finds its config. Returns the linked paths.
 */
export async function linkIgnoredFiles(
  sourceRepo: string,
  worktreePath: string,
): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", sourceRepo, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const linked: string[] = [];
  for (const file of linkableIgnored(stdout.split("\n"))) {
    const from = path.join(sourceRepo, file);
    const to = path.join(worktreePath, file);
    const info = await lstat(from).catch(() => null);
    if (!info?.isFile() || info.size > MAX_LINKED_BYTES || existsSync(to)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await symlink(from, to).then(
      () => linked.push(file),
      () => undefined,
    );
  }
  return linked;
}

/**
 * The hub's `.claude/skills` as a local plugin the Agent SDK loads (Claude
 * Code reads the hub's CLAUDE.md from the parent folders, but not its skills).
 * Skills show up as `<hub name>:<skill>`. Null when the hub has none.
 */
export async function hubPlugin(hub: string): Promise<{ path: string; skills: string[] } | null> {
  const skillsDir = path.join(hub, ".claude", "skills");
  const skills = await readdir(skillsDir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((e) => e.isDirectory() && existsSync(path.join(skillsDir, e.name, "SKILL.md")))
        .map((e) => e.name),
    )
    .catch(() => []);
  if (skills.length === 0) return null;
  const id = createHash("sha256").update(hub).digest("hex").slice(0, 12);
  const dir = path.join(HUB_PLUGINS_ROOT, id);
  await mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: pluginName(hub), description: `Skills of the work hub at ${hub}` })}\n`,
  );
  const link = path.join(dir, "skills");
  if (!existsSync(link)) await symlink(skillsDir, link);
  return { path: dir, skills };
}

/** Plugin names are kebab-case; the hub folder's name is what people call it ("work"). */
export function pluginName(hub: string): string {
  return (
    path
      .basename(hub)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "hub"
  );
}

/** Appended to every session's system prompt in a hub worktree. Pure. */
export function hubPromptSection(hub: string, worktreePath: string): string {
  return [
    "## Work hub",
    `This repository is part of the work hub at \`${hub}\`. Its CLAUDE.md/AGENTS.md (already loaded) and its knowledge apply: read what is relevant (Read/Grep/Glob work anywhere in the hub; \`repos/\` holds clean reference checkouts of the other repos).`,
    `ZASTAVA already did the hub's worktree setup: you are in \`${worktreePath}\`, on a fresh branch from the latest base, with the source checkout's ignored config files linked in. Do not create worktrees, do not edit \`repos/\` or anything outside this worktree, and do not commit, push or open pull requests: ZASTAVA delivers the work.`,
    "Where the hub tells you to load a skill and it is not available here, follow its intent with the instructions you have.",
  ].join("\n\n");
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What a session in a hub worktree adds to its options: the hub readable,
 * its skills as a plugin (with the Skill tool to use them) and the hub
 * section of the system prompt. Null outside a hub.
 */
export async function hubSession(worktreePath: string): Promise<{
  hub: string;
  readRoots: string[];
  plugins: { type: "local"; path: string }[];
  tools: string[];
  prompt: string;
} | null> {
  const hub = hubOfWorktree(worktreePath);
  if (!hub) return null;
  const plugin = await hubPlugin(hub).catch(() => null);
  return {
    hub,
    readRoots: [hub],
    plugins: plugin ? [{ type: "local", path: plugin.path }] : [],
    tools: plugin ? ["Skill"] : [],
    prompt: hubPromptSection(hub, worktreePath),
  };
}
