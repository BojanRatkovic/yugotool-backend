import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectSkills, sessionSkills, skillDescription } from "./index";

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
});
