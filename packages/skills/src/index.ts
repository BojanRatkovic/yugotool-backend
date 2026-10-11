// Which skills an agent of a project can load (spec 0015): read from disk by
// the API (for `/` autocomplete) and by the worker (to tell a session which
// of the named ones to load), with the same rules the worker loads them by.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProjectSkill } from "@zastava/contracts";

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

/**
 * Plugins the hub ships itself (`<hub>/plugins/<name>/.claude-plugin/plugin.json`,
 * how a hub serves its skills to sessions whose cwd is a worktree).
 */
export function bundledHubPlugins(hub: string): string[] {
  const root = path.join(hub, "plugins");
  return subdirs(root)
    .filter((name) => existsSync(path.join(root, name, ".claude-plugin", "plugin.json")))
    .map((name) => path.join(root, name));
}

/** The name a plugin's skills are invoked under: its manifest's, else its folder's. */
export function manifestName(pluginDir: string): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const name = typeof manifest === "object" && manifest ? Reflect.get(manifest, "name") : null;
    if (typeof name === "string" && name) return name;
  } catch {
    // Unreadable manifest: the folder name is what the SDK falls back to as well.
  }
  return path.basename(pluginDir);
}

/** `description` from a SKILL.md's frontmatter (plain, quoted or a `>`/`|` block). Pure. */
export function skillDescription(skillMd: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (!front) return "";
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith("description:"));
  if (at === -1) return "";
  const inline = lines[at]!.replace(/^description:\s*/, "").trim();
  if (inline && !/^[>|][+-]?$/.test(inline)) return inline.replace(/^(["'])(.*)\1$/, "$2");
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(" ");
}

interface Found extends ProjectSkill {
  /** Real path of the SKILL.md: a hub plugin often symlinks a repo's skills. */
  file: string;
}

/** `<dir>/<skill>/SKILL.md` as skills, invoked as `<prefix>:<skill>` or bare. */
function skillsIn(
  dir: string,
  prefix: string | null,
  source: ProjectSkill["source"],
  repo: string | null,
): Found[] {
  return subdirs(dir).flatMap((name) => {
    const file = path.join(dir, name, "SKILL.md");
    let text: string;
    let real: string;
    try {
      text = readFileSync(file, "utf8");
      real = realpathSync(file);
    } catch {
      return [];
    }
    const invocation = prefix ? `${prefix}:${name}` : name;
    return [{ invocation, description: skillDescription(text), source, repo, file: real }];
  });
}

function hubFound(hub: string): Found[] {
  const bundled = bundledHubPlugins(hub);
  const shipped = bundled.flatMap((dir) =>
    skillsIn(path.join(dir, "skills"), manifestName(dir), "hub", null),
  );
  // `.claude/skills` loads as a generated plugin named after the hub, unless one ships under that name.
  const own = bundled.some((dir) => manifestName(dir) === pluginName(hub))
    ? []
    : skillsIn(path.join(hub, ".claude", "skills"), pluginName(hub), "hub", null);
  return [...shipped, ...own];
}

const repoFound = (repoPath: string, repo: string | null): Found[] =>
  skillsIn(path.join(repoPath, ".claude", "skills"), null, "repo", repo);

/**
 * Every skill a project's agents can load. A hub: its plugins, then each
 * repo's own skills that no hub plugin already serves. A repo: its own.
 */
export function projectSkills(project: { kind: "repo" | "hub"; repoPath: string }): ProjectSkill[] {
  if (project.kind !== "hub") return strip(repoFound(project.repoPath, null));
  const hub = hubFound(project.repoPath);
  const served = new Set(hub.map((s) => s.file));
  const reposDir = path.join(project.repoPath, "repos");
  const repos = subdirs(reposDir).flatMap((name) =>
    repoFound(path.join(reposDir, name), name).filter((s) => !served.has(s.file)),
  );
  return strip([...hub, ...repos]);
}

/**
 * The invocations a session can load: the hub's plugins (when it runs on a
 * hub) plus the skills of the checkout it runs in.
 */
export function sessionSkills(cwd: string, hub: string | null): string[] {
  const found = [...(hub ? hubFound(hub) : []), ...(cwd === hub ? [] : repoFound(cwd, null))];
  return [...new Set(found.map((s) => s.invocation))];
}

const strip = (found: Found[]): ProjectSkill[] => found.map(({ file: _file, ...skill }) => skill);

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
