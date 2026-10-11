// Work hubs (spec 0012): a folder whose `repos/` holds the code checkouts and
// whose CLAUDE.md/AGENTS.md, knowledge and skills teach agents that code.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hubCandidateOf } from "@yugotool/contracts";
import { bundledHubPlugins, hubUserPlugins, manifestName, pluginName } from "@yugotool/skills";

export { bundledHubPlugins, pluginName };

const exec = promisify(execFile);

/** Where generated hub plugins live (one per hub, its skills symlinked in). */
const HUB_PLUGINS_ROOT = path.join(os.homedir(), ".yugotool", "hub-plugins");

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

/** `<hub>/worktrees/<repo>-yugotool-<suffix>`, the hub's own naming. Pure. */
export function hubWorktreePath(hub: string, repoPath: string, suffix: string): string {
  return path.join(hub, "worktrees", `${path.basename(repoPath)}-yugotool-${suffix}`);
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

/** Appended to every session's system prompt in a hub worktree. Pure. */
export function hubPromptSection(hub: string, worktreePath: string): string {
  return [
    "## Work hub",
    `This repository is part of the work hub at \`${hub}\`. Its instructions (below) and its knowledge apply: read what is relevant (Read/Grep/Glob work anywhere in the hub; \`repos/\` holds clean reference checkouts of the other repos). Its skills are available through the Skill tool.`,
    `YugoTool already did the hub's worktree setup: you are in \`${worktreePath}\`, on a fresh branch from the latest base, with the source checkout's ignored config files linked in. Do not create worktrees, do not edit \`repos/\` or anything outside this worktree, and do not commit, push or open pull requests: YugoTool delivers the work.`,
    "Where the hub tells you to load a skill and it is not available here, follow its intent with the instructions you have. Where the hub's instructions below conflict with this section, this section wins.",
  ].join("\n\n");
}

const MAX_INSTRUCTIONS = 64 * 1024;

/**
 * The hub's CLAUDE.md (else AGENTS.md) with its `@file` import lines expanded,
 * one level, files inside the hub only. A session in a hub worktree loads the
 * hub's CLAUDE.md from the parent folder but not its imports (they sit outside
 * the session's project), so the hub's rules never reached it. Null without one.
 */
export async function hubInstructions(hub: string): Promise<string | null> {
  const file = ["CLAUDE.md", "AGENTS.md"].map((f) => path.join(hub, f)).find((f) => existsSync(f));
  if (!file) return null;
  const lines = (await readFile(file, "utf8")).split("\n");
  const expanded = await Promise.all(
    lines.map(async (line) => {
      const target = /^@(\S+)\s*$/.exec(line.trim())?.[1];
      if (!target) return line;
      const resolved = path.resolve(hub, target);
      if (!resolved.startsWith(`${hub}${path.sep}`)) return line;
      return readFile(resolved, "utf8").catch(() => line);
    }),
  );
  const text = expanded.join("\n").trim();
  return text ? text.slice(0, MAX_INSTRUCTIONS) : null;
}

/** What Activity names: the hub's bundled plugins and, when it has `.claude/skills`, those skills. */
export async function hubPluginNames(hub: string): Promise<string[]> {
  const plugins = await hubPlugins(hub);
  const bundled = new Set(bundledHubPlugins(hub));
  return plugins.map((p) =>
    bundled.has(p.path) || !p.path.startsWith(HUB_PLUGINS_ROOT)
      ? manifestName(p.path)
      : pluginName(hub),
  );
}

/**
 * Every plugin a session on this hub loads: the bundled ones, plus `.claude/skills`
 * as one, plus the account's plugins the hub invokes (`configDir`, spec 0016).
 */
export async function hubPlugins(
  hub: string,
  configDir?: string,
): Promise<{ type: "local"; path: string }[]> {
  const bundled = bundledHubPlugins(hub);
  const generated = await hubPlugin(hub).catch(() => null);
  // A bundled plugin named like the hub already is "the hub's skills"; two would clash.
  const clash = bundled.some((dir) => manifestName(dir) === pluginName(hub));
  const paths = [
    ...bundled,
    ...(generated && !clash ? [generated.path] : []),
    // Plugins the hub's instructions invoke, from where the person installed them.
    ...hubUserPlugins(hub, configDir),
  ];
  return paths.map((p) => ({ type: "local" as const, path: p }));
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
 * its plugins (with the Skill tool to use them) and the hub section of the
 * system prompt, with the hub's instructions in it. Null outside a hub.
 */
export async function hubSession(
  worktreePath: string,
  configDir?: string,
): Promise<{
  hub: string;
  readRoots: string[];
  plugins: { type: "local"; path: string }[];
  tools: string[];
  prompt: string;
} | null> {
  const hub = hubOfWorktree(worktreePath);
  if (!hub) return null;
  const plugins = await hubPlugins(hub, configDir);
  const instructions = await hubInstructions(hub);
  return {
    hub,
    readRoots: [hub],
    plugins,
    tools: plugins.length ? ["Skill"] : [],
    prompt: instructions
      ? `${hubPromptSection(hub, worktreePath)}\n\n## The hub's instructions\n\n${instructions}`
      : hubPromptSection(hub, worktreePath),
  };
}
