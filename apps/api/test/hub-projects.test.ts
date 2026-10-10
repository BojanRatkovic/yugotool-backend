import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project, RepoSettings, UpdateHubRepo } from "@zastava/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubRepoNotFoundError } from "../src/modules/projects/project.errors";
import { ProjectsService } from "../src/modules/projects/projects.service";
import { detectBaseBranch } from "../src/modules/projects/work-hub";
import { ReposService } from "../src/modules/repos/repos.service";

const root = mkdtempSync(path.join(os.tmpdir(), "zastava-api-hub-projects-"));
const hub = path.join(root, "work");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function initRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
}

beforeAll(() => {
  mkdirSync(path.join(hub, "repos"), { recursive: true });
  writeFileSync(path.join(hub, "CLAUDE.md"), "# hub\n");
  // api: cloned from an origin whose HEAD is develop.
  const seed = path.join(root, "seed");
  initRepo(seed, "develop");
  git(root, "clone", "-q", "--bare", seed, path.join(root, "api.git"));
  git(path.join(hub, "repos"), "clone", "-q", path.join(root, "api.git"), "api");
  // web: no remote, on main. legacy: no remote, master only, checked out elsewhere.
  initRepo(path.join(hub, "repos", "web"), "main");
  initRepo(path.join(hub, "repos", "legacy"), "master");
  git(path.join(hub, "repos", "legacy"), "checkout", "-q", "-b", "feature");
  // a regular repo next to the hub
  initRepo(path.join(root, "solo"), "main");
});

/** In-memory stand-in for ProjectsRepository (no Postgres in API tests). */
class MemoryProjects {
  rows = new Map<string, Project & { repoSettings: RepoSettings | null }>();
  inserted: Record<string, unknown>[] = [];

  private view(id: string): Project | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const { repoSettings, ...project } = row;
    const repos = Object.entries(repoSettings ?? {})
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => ({
        name,
        path: `${row.repoPath}/repos/${name}`,
        baseBranch: s.baseBranch,
        preview: s.preview ?? null,
      }));
    return { ...project, repos };
  }

  async list(): Promise<Project[]> {
    return [...this.rows.keys()].map((id) => this.view(id)).filter((p) => p !== null);
  }
  async find(_db: unknown, id: string): Promise<Project | null> {
    return this.view(id);
  }
  async insert(_db: unknown, values: Record<string, unknown>) {
    this.inserted.push(values);
    const id = (values["id"] as string | undefined) ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.rows.set(id, {
      id,
      kind: (values["kind"] as Project["kind"] | undefined) ?? "repo",
      name: values["name"] as string,
      repoPath: values["repoPath"] as string,
      baseBranch: values["baseBranch"] as string,
      preview: null,
      deliveryDefault: "local",
      hubPath: null,
      repos: [],
      repoSettings: (values["repoSettings"] as RepoSettings | null | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { project: this.view(id) as Project, created: true };
  }
  async insertLine(): Promise<void> {}
  async addRepoSettings(_db: unknown, id: string, added: RepoSettings): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.repoSettings = { ...added, ...row.repoSettings };
  }
  async updateRepoSettings(_db: unknown, id: string, repo: string, patch: UpdateHubRepo) {
    const row = this.rows.get(id);
    if (!row) return null;
    const current = row.repoSettings?.[repo] ?? { baseBranch: "main", preview: null };
    const next = {
      baseBranch: patch.baseBranch ?? current.baseBranch,
      preview: patch.preview === undefined ? current.preview : patch.preview,
    };
    row.repoSettings = { ...row.repoSettings, [repo]: next };
    return this.view(id);
  }
}

function service() {
  const repository = new MemoryProjects();
  const events: unknown[] = [];
  const database = { db: {}, transaction: (fn: (tx: unknown) => unknown) => fn({}) };
  const svc = new ProjectsService(
    database as never,
    repository as never,
    { publish: async (e: unknown) => void events.push(e) } as never,
    {} as never,
  );
  return { svc, repository, events };
}

describe("hub projects (spec 0014)", () => {
  it("detects each repo's base branch: origin/HEAD, else develop → main → master", async () => {
    expect(await detectBaseBranch(path.join(hub, "repos", "api"))).toBe("develop");
    expect(await detectBaseBranch(path.join(hub, "repos", "web"))).toBe("main");
    expect(await detectBaseBranch(path.join(hub, "repos", "legacy"))).toBe("master");
  });

  it("creates a hub project with its repos and detected base branches", async () => {
    const { svc } = service();
    const project = await svc.create({ name: "work", repoPath: hub, baseBranch: "main" });
    expect(project.kind).toBe("hub");
    expect(project.repos.map((r) => [r.name, r.baseBranch])).toEqual([
      ["api", "develop"],
      ["legacy", "master"],
      ["web", "main"],
    ]);
    expect(project.repos[0]?.path).toBe(path.join(hub, "repos", "api"));
  });

  it("creates regular and hub-repo projects exactly as before", async () => {
    const { svc, repository } = service();
    const solo = await svc.create({
      name: "solo",
      repoPath: path.join(root, "solo"),
      baseBranch: "main",
    });
    const api = await svc.create({
      name: "api",
      repoPath: path.join(hub, "repos", "api"),
      baseBranch: "develop",
    });
    expect([solo.kind, api.kind]).toEqual(["repo", "repo"]);
    expect([solo.repos, api.repos]).toEqual([[], []]);
    for (const values of repository.inserted) {
      expect(values).not.toHaveProperty("kind");
      expect(values).not.toHaveProperty("repoSettings");
    }
  });

  it("picks up a repo cloned into the hub later and drops a removed one", async () => {
    const { svc } = service();
    await svc.create({ name: "work", repoPath: hub, baseBranch: "main" });
    initRepo(path.join(hub, "repos", "docs"), "main");
    rmSync(path.join(hub, "repos", "legacy"), { recursive: true, force: true });
    try {
      const [project] = await svc.list();
      expect(project?.repos.map((r) => r.name)).toEqual(["api", "docs", "web"]);
    } finally {
      rmSync(path.join(hub, "repos", "docs"), { recursive: true, force: true });
      initRepo(path.join(hub, "repos", "legacy"), "master");
    }
  });

  it("updates one repo's base branch and preview; unknown repos and repo projects 404", async () => {
    const { svc, events } = service();
    const project = await svc.create({ name: "work", repoPath: hub, baseBranch: "main" });
    const preview = {
      install: null,
      start: "pnpm dev --port $PORT",
      readyPath: "/",
      readyTimeoutSec: 120,
      env: {},
      baseUrlPath: "/",
      themeInit: null,
      host: null,
    };
    const updated = await svc.updateHubRepo(project.id, "web", { preview });
    const web = updated.repos.find((r) => r.name === "web");
    expect(web).toMatchObject({ baseBranch: "main", preview: { start: "pnpm dev --port $PORT" } });
    const again = await svc.updateHubRepo(project.id, "web", { baseBranch: "release" });
    expect(again.repos.find((r) => r.name === "web")).toMatchObject({
      baseBranch: "release",
      preview: { start: "pnpm dev --port $PORT" },
    });
    expect(events).toContainEqual({ type: "invalidate", collection: "projects" });

    await expect(svc.updateHubRepo(project.id, "nope", { baseBranch: "x" })).rejects.toBeInstanceOf(
      HubRepoNotFoundError,
    );
    const solo = await svc.create({
      name: "solo",
      repoPath: path.join(root, "solo"),
      baseBranch: "main",
    });
    await expect(svc.updateHubRepo(solo.id, "api", { baseBranch: "x" })).rejects.toBeInstanceOf(
      HubRepoNotFoundError,
    );
  });

  it("the repo picker lists the hub itself above its repos", async () => {
    const repos = new ReposService(
      { get: () => root } as never,
      { get: async () => ({ reposRoot: root }) } as never,
    );
    const list = await repos.list();
    const names = list.map((r) => r.name);
    expect(names.indexOf("work")).toBeLessThan(names.indexOf("work/api"));
    expect(list.find((r) => r.name === "work")).toMatchObject({
      kind: "hub",
      path: hub,
      hubPath: hub,
      repoCount: 3,
    });
    expect(list.find((r) => r.name === "work/api")).toMatchObject({
      kind: "repo",
      hubPath: hub,
      repoCount: null,
    });
    expect(list.find((r) => r.name === "solo")).toMatchObject({ kind: "repo", hubPath: null });
  });
});
