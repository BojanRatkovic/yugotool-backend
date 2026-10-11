import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  enabledUserPlugins,
  hubUserPlugins,
  invokedPlugins,
  projectSkills,
  sessionSkills,
  skillDescription,
} from "./index";

const root = mkdtempSync(path.join(os.tmpdir(), "zastava-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string, description: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
}

describe("project skills (spec 0015)", () => {
  it("reads plain, quoted and block descriptions", () => {
    expect(skillDescription("---\ndescription: Plain one.\n---\n")).toBe("Plain one.");
    expect(skillDescription('---\ndescription: "Quoted."\n---\n')).toBe("Quoted.");
    expect(skillDescription("---\ndescription: >\n  Folded\n  text.\nname: x\n---\n")).toBe(
      "Folded text.",
    );
    expect(skillDescription("no frontmatter")).toBe("");
  });

  it("lists a hub's plugins and the repo skills no plugin serves", () => {
    const hub = path.join(root, "work");
    const app = path.join(hub, "repos", "app");
    mkdirSync(path.join(app, ".git"), { recursive: true });
    skill(path.join(app, ".claude", "skills"), "rails-way", "Rails rules.");
    skill(path.join(app, ".claude", "skills"), "local-only", "Only here.");
    const plugin = path.join(hub, "plugins", "work-repos");
    mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"repos"}');
    mkdirSync(path.join(plugin, "skills"));
    symlinkSync(
      path.join(app, ".claude", "skills", "rails-way"),
      path.join(plugin, "skills", "rails-way"),
    );
    skill(path.join(hub, ".claude", "skills"), "domain", "Hub domain.");

    expect(projectSkills({ kind: "hub", repoPath: hub })).toEqual([
      { invocation: "repos:rails-way", description: "Rails rules.", source: "hub", repo: null },
      { invocation: "work:domain", description: "Hub domain.", source: "hub", repo: null },
      { invocation: "local-only", description: "Only here.", source: "repo", repo: "app" },
    ]);
    expect(projectSkills({ kind: "repo", repoPath: app }).map((s) => s.invocation)).toEqual([
      "local-only",
      "rails-way",
    ]);
    expect(sessionSkills(hub, hub)).toEqual(["repos:rails-way", "work:domain"]);
    expect(sessionSkills(app, hub)).toContain("local-only");
  });

  it("loads the user plugins a hub's instructions invoke", () => {
    expect(invokedPlugins("Load the `/p-dev:code` skill. See src/a:b and https://x/y:z")).toEqual([
      "p-dev",
    ]);
    const config = path.join(root, "config");
    const installed = path.join(root, "cache", "p-dev");
    mkdirSync(path.join(installed, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(installed, ".claude-plugin", "plugin.json"), '{"name":"p-dev"}');
    skill(path.join(installed, "skills"), "code", "Coding rules.");
    mkdirSync(path.join(config, "plugins"), { recursive: true });
    writeFileSync(
      path.join(config, "settings.json"),
      JSON.stringify({ enabledPlugins: { "p-dev@acme": true, "off@acme": false } }),
    );
    writeFileSync(
      path.join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p-dev@acme": [{ installPath: installed }] } }),
    );
    expect([...enabledUserPlugins(config)]).toEqual([["p-dev", installed]]);
    const hub = path.join(root, "phub");
    mkdirSync(hub);
    writeFileSync(path.join(hub, "AGENTS.md"), "You must load the `/p-dev:code` skill.\n");
    expect(hubUserPlugins(hub, config)).toEqual([installed]);
    // The `/` menu and sessions offer the plugin only on the account that installed it (spec 0016).
    const other = path.join(root, "config-other");
    mkdirSync(other);
    const invocations = (dir: string) =>
      projectSkills({ kind: "hub", repoPath: hub }, dir).map((s) => s.invocation);
    expect(invocations(config)).toContain("p-dev:code");
    expect(invocations(other)).not.toContain("p-dev:code");
    expect(sessionSkills(hub, hub, config)).toContain("p-dev:code");
    expect(sessionSkills(hub, hub, other)).not.toContain("p-dev:code");
    writeFileSync(path.join(hub, "AGENTS.md"), "No plugins here.\n");
    expect(hubUserPlugins(hub, config)).toEqual([]);
  });
});
