import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import {
  type CreateProject,
  DEFAULT_STATIONS,
  type Line,
  type PreviewDetection,
  type PreviewStatus,
  type PreviewTestResult,
  previewTestResultSchema,
  type Project,
  type ProjectStats,
  type RouteMapStatus,
  TASK_QUEUE,
  type UpdateLine,
  type UpdateProject,
  type UpdateRoutes,
} from "@zastava/contracts";
import { previewTestDir } from "../../core/artifacts/artifacts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import {
  PreviewNotConfiguredError,
  PreviewScreenshotMissingError,
  PreviewTestRunningError,
  ProjectNotFoundError,
  RepoPathInvalidError,
  RouteDiscoveryRunningError,
} from "./project.errors";
import { detectPreview } from "./preview-detect";
import { ProjectsRepository } from "./projects.repository";
import { readRepoFacts } from "./repo-facts";
import { baseRef, routeSourceHash } from "./route-hash";

const discoveryWorkflowId = (projectId: string): string => `discover-routes-${projectId}`;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProjectsRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  list(): Promise<Project[]> {
    return this.repository.list(this.database.db);
  }

  async create(input: CreateProject): Promise<Project> {
    const repoPath = path.resolve(input.repoPath);
    if (!existsSync(path.join(repoPath, ".git"))) {
      throw new RepoPathInvalidError(`${repoPath} is not a git repository`);
    }
    const project = await this.database.transaction(async (tx) => {
      const result = await this.repository.insert(tx, { ...input, repoPath });
      if (result.created) await this.repository.insertLine(tx, result.project.id, DEFAULT_STATIONS);
      return result.project;
    });
    await this.events.publish({ type: "invalidate", collection: "projects" });
    return project;
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
}
