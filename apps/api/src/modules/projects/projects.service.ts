import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import {
  type CreateProject,
  DEFAULT_STATIONS,
  type Line,
  type PreviewDetection,
  type ProjectRemote,
  type ProjectSkill,
  type PreviewStatus,
  type PreviewTestResult,
  previewTestResultSchema,
  type Project,
  type ProjectStats,
  REVIEW_LINE_STATIONS,
  type RouteMapStatus,
  TASK_QUEUE,
  type RepoSettings,
  type UpdateHubRepo,
  type UpdateLine,
  type UpdateProject,
  type UpdateRoutes,
} from "@zastava/contracts";
import { previewTestDir } from "../../core/artifacts/artifacts";
import { projectSkills } from "@zastava/skills";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import {
  PreviewNotConfiguredError,
  PreviewScreenshotMissingError,
  PreviewTestRunningError,
  ProjectHasActiveWorkError,
  ProjectNotFoundError,
  HubRepoNotFoundError,
  NotForHubProjectsError,
  RepoPathInvalidError,
  RouteDiscoveryRunningError,
} from "./project.errors";
import { detectBaseBranch, hubRepos, isHubRoot } from "./work-hub";
import { detectPreview } from "./preview-detect";
import { removeProjectFiles } from "./project-cleanup";
import { projectRemote } from "./project-remote";
import { ProjectsRepository } from "./projects.repository";
import { readRepoFacts } from "./repo-facts";
import { baseRef, routeSourceHash } from "./route-hash";

/** Detected base branch per repo, no preview yet (spec 0014). */
async function detectRepoSettings(repos: { name: string; path: string }[]): Promise<RepoSettings> {
  const entries = await Promise.all(
    repos.map(async (r) => [r.name, { baseBranch: await detectBaseBranch(r.path), preview: null }]),
  );
  return Object.fromEntries(entries);
}

const discoveryWorkflowId = (projectId: string): string => `discover-routes-${projectId}`;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProjectsRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  async list(): Promise<Project[]> {
    const projects = await this.repository.list(this.database.db);
    return Promise.all(projects.map((p) => this.withHubRepos(p)));
  }

  async create(input: CreateProject): Promise<Project> {
    const repoPath = path.resolve(input.repoPath);
    // A work hub is a hub project: each run picks one of its repos (spec 0014).
    const hub = isHubRoot(repoPath);
    if (!hub && !existsSync(path.join(repoPath, ".git"))) {
      throw new RepoPathInvalidError(`${repoPath} is not a Git repository`);
    }
    const repoSettings = hub ? await detectRepoSettings(hubRepos(repoPath)) : null;
    const project = await this.database.transaction(async (tx) => {
      const result = await this.repository.insert(tx, {
        ...input,
        repoPath,
        ...(hub ? { kind: "hub" as const, repoSettings } : {}),
      });
      if (result.created) await this.repository.insertLine(tx, result.project.id, DEFAULT_STATIONS);
      return result.project;
    });
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return project;
  }

  /**
   * Deletes the project with its line, work orders and run history, then its
   * worktrees and artifacts on disk. Refused while work is queued, on the line
   * or at a gate. The repository itself and its branches are never touched.
   */
  async delete(projectId: string): Promise<void> {
    const { project, worktrees, runIds } = await this.database.transaction(async (tx) => {
      const active = await this.repository.lockAndCountActive(tx, projectId);
      if (active === null) throw new ProjectNotFoundError(`project ${projectId} not found`);
      if (active > 0) {
        throw new ProjectHasActiveWorkError(
          `${active} work ${active === 1 ? "order is" : "orders are"} queued, running or waiting at a gate. Cancel or finish ${active === 1 ? "it" : "them"} first.`,
          { active },
        );
      }
      const found = await this.repository.find(tx, projectId);
      const files = {
        worktrees: await this.repository.runWorktrees(tx, projectId),
        runIds: await this.repository.runIds(tx, projectId),
      };
      await this.repository.delete(tx, projectId);
      return { project: found, ...files };
    });
    await this.temporal.workflow
      .getHandle(discoveryWorkflowId(projectId))
      .terminate("project deleted")
      .catch(() => undefined);
    if (project) {
      const failed = await removeProjectFiles({
        projectId,
        kind: project.kind,
        repoPath: project.repoPath,
        worktrees,
        runIds,
      });
      if (failed.length) this.logger.warn(`could not remove: ${failed.join(", ")}`);
    }
    for (const collection of ["projects", "work_orders", "runs", "dispatcher"] as const) {
      await this.events.publish({ type: "invalidate", collection });
    }
  }

  /** Hub projects: one repo's base branch and preview (spec 0014). */
  async updateHubRepo(projectId: string, repo: string, input: UpdateHubRepo): Promise<Project> {
    const found = await this.repository.find(this.database.db, projectId);
    if (!found) throw new ProjectNotFoundError(`project ${projectId} not found`);
    const project = await this.withHubRepos(found);
    if (project.kind !== "hub" || !project.repos.some((r) => r.name === repo)) {
      throw new HubRepoNotFoundError(`${repo} is not a repo of project ${project.name}`);
    }
    const updated = await this.repository.updateRepoSettings(
      this.database.db,
      projectId,
      repo,
      input,
    );
    if (!updated) throw new ProjectNotFoundError(`project ${projectId} not found`);
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return this.withHubRepos(updated);
  }

  /**
   * A hub project's repos as they are on disk now: a repo cloned into the hub
   * later gets its base branch detected and saved; a removed one is left out.
   */
  private async withHubRepos(project: Project): Promise<Project> {
    if (project.kind !== "hub") return project;
    const onDisk = hubRepos(project.repoPath);
    const known = new Set(project.repos.map((r) => r.name));
    const added = onDisk.filter((r) => !known.has(r.name));
    if (added.length) {
      await this.repository.addRepoSettings(
        this.database.db,
        project.id,
        await detectRepoSettings(added),
      );
      const fresh = await this.repository.find(this.database.db, project.id);
      if (fresh) project = fresh;
    }
    const present = new Set(onDisk.map((r) => r.name));
    return { ...project, repos: project.repos.filter((r) => present.has(r.name)) };
  }

  async skills(projectId: string): Promise<ProjectSkill[]> {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    return projectSkills(project);
  }

  async update(projectId: string, input: UpdateProject): Promise<Project> {
    const project = await this.repository.update(this.database.db, projectId, input);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return project;
  }

  /**
   * Boots the preview once on the base branch (in the worker, which owns the
   * browser and process management) and waits for the result.
   */
  async testPreview(projectId: string): Promise<PreviewTestResult> {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    if (!project.preview) throw new PreviewNotConfiguredError("set up the preview first");
    try {
      return await this.temporal.workflow.execute("previewTest", {
        taskQueue: TASK_QUEUE,
        workflowId: `preview-test-${projectId}`,
        args: [{ projectId }],
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new PreviewTestRunningError("a preview test is already running for this project");
      }
      throw error;
    }
  }

  /** Hub projects: where one repo's work can go (`repo`); the hub's own remote says nothing. */
  async remote(projectId: string, repo?: string): Promise<ProjectRemote> {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    if (project.kind === "hub" && repo) {
      const target = (await this.withHubRepos(project)).repos.find((r) => r.name === repo);
      if (!target)
        throw new HubRepoNotFoundError(`${repo} is not a repo of project ${project.name}`);
      return projectRemote(target.path);
    }
    return projectRemote(project.repoPath);
  }

  /** Proposes a preview from the repo's root files on the base branch; saves nothing. */
  async detectPreview(projectId: string): Promise<PreviewDetection> {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    const ref = await baseRef(project.repoPath, project.baseBranch);
    return detectPreview(await readRepoFacts(project.repoPath, ref));
  }

  async previewStatus(projectId: string): Promise<PreviewStatus> {
    const raw = await readFile(path.join(previewTestDir(projectId), "result.json"), "utf8").catch(
      () => null,
    );
    const parsed = raw ? previewTestResultSchema.safeParse(JSON.parse(raw)) : null;
    return { last: parsed?.success ? parsed.data : null };
  }

  previewScreenshot(projectId: string): string {
    const file = path.join(previewTestDir(projectId), "screenshot.png");
    if (!existsSync(file)) throw new PreviewScreenshotMissingError("no preview screenshot yet");
    return file;
  }

  /** The route map, whether its sources changed on the base branch, and the last discovery. */
  async routes(projectId: string): Promise<RouteMapStatus> {
    const row = await this.repository.findRouteMap(this.database.db, projectId);
    if (!row) throw new ProjectNotFoundError(`project ${projectId} not found`);
    const map = row.routeMap ?? null;
    let stale = false;
    if (map?.sourceHash && map.routerFiles.length) {
      const ref = await baseRef(row.repoPath, row.baseBranch);
      const current = await routeSourceHash(row.repoPath, ref, map.routerFiles).catch(() => null);
      stale = current !== null && current !== map.sourceHash;
    }
    return {
      map,
      stale,
      discovering: await this.discoveryRunning(projectId),
      lastDiscovery: row.routeDiscovery ?? null,
    };
  }

  /** Starts a discovery session in the worker; the result arrives as a projects invalidate. */
  async discoverRoutes(projectId: string): Promise<RouteMapStatus> {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    if (project.kind === "hub") {
      throw new NotForHubProjectsError("route discovery is per repo, not yet for hub projects");
    }
    if (await this.discoveryRunning(projectId)) {
      throw new RouteDiscoveryRunningError("route discovery is already running for this project");
    }
    try {
      await this.temporal.workflow.start("discoverRoutes", {
        taskQueue: TASK_QUEUE,
        workflowId: discoveryWorkflowId(projectId),
        args: [{ projectId }],
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new RouteDiscoveryRunningError("route discovery is already running for this project");
      }
      throw error;
    }
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return this.routes(projectId);
  }

  /** A human edit: the map keeps its source hash but is never regenerated automatically. */
  async updateRoutes(projectId: string, input: UpdateRoutes): Promise<RouteMapStatus> {
    const row = await this.repository.findRouteMap(this.database.db, projectId);
    if (!row) throw new ProjectNotFoundError(`project ${projectId} not found`);
    await this.repository.setRouteMap(this.database.db, projectId, {
      routerFiles: input.routerFiles ?? row.routeMap?.routerFiles ?? [],
      routes: input.routes,
      sourceHash: row.routeMap?.sourceHash ?? null,
      generatedAt: row.routeMap?.generatedAt ?? new Date().toISOString(),
      editedByHuman: true,
    });
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return this.routes(projectId);
  }

  private async discoveryRunning(projectId: string): Promise<boolean> {
    try {
      const description = await this.temporal.workflow
        .getHandle(discoveryWorkflowId(projectId))
        .describe();
      return description.status.name === "RUNNING";
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return false;
      throw error;
    }
  }

  /** Running workflows keep the stations they started with; edits apply to new runs. */
  async updateLine(projectId: string, input: UpdateLine): Promise<Line> {
    const line = await this.repository.updateLine(this.database.db, projectId, input.stations);
    if (!line) throw new ProjectNotFoundError(`project ${projectId} not found`);
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return line;
  }

  stats(projectId: string): Promise<ProjectStats> {
    return this.repository.stats(this.database.db, projectId);
  }

  async getLine(projectId: string): Promise<Line> {
    const line = await this.repository.findLine(this.database.db, projectId);
    if (!line) throw new ProjectNotFoundError(`project ${projectId} not found`);
    return line;
  }

  /** The project's review line (spec 0009), seeded from the template on first use. */
  async getReviewLine(projectId: string): Promise<Line> {
    const db = this.database.db;
    const existing = await this.repository.findLine(db, projectId, "review");
    if (existing) return existing;
    if (!(await this.repository.find(db, projectId))) {
      throw new ProjectNotFoundError(`project ${projectId} not found`);
    }
    await this.repository.insertLine(db, projectId, REVIEW_LINE_STATIONS, "review");
    const line = await this.repository.findLine(db, projectId, "review");
    if (!line) throw new ProjectNotFoundError(`project ${projectId} not found`);
    return line;
  }

  async updateReviewLine(projectId: string, input: UpdateLine): Promise<Line> {
    await this.getReviewLine(projectId);
    const line = await this.repository.updateLine(
      this.database.db,
      projectId,
      input.stations,
      "review",
    );
    if (!line) throw new ProjectNotFoundError(`project ${projectId} not found`);
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return line;
  }
}
