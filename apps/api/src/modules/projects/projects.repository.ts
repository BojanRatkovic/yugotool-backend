import { Injectable } from "@nestjs/common";
import type {
  HubRepo,
  Line,
  LineKind,
  Project,
  ProjectKind,
  ProjectStats,
  RepoSettings,
  RouteMap,
  Station,
  UpdateHubRepo,
  UpdateProject,
} from "@zastava/contracts";
import {
  claudeAccounts,
  type Executor,
  lines,
  projects,
  runs,
  stationRuns,
  workOrders,
} from "@zastava/db";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { iso } from "../../common/mappers";
import { hubOfRepo } from "./work-hub";

type ProjectRow = typeof projects.$inferSelect;
type LineRow = typeof lines.$inferSelect;

const toProject = ({
  routeMap: _map,
  routeDiscovery: _discovery,
  repoSettings,
  ...row
}: ProjectRow): Project => ({
  ...row,
  hubPath: row.kind === "hub" ? row.repoPath : hubOfRepo(row.repoPath),
  repos: hubReposOf(row.repoPath, repoSettings),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

/** A hub project's repos, by name, from its stored per-repo settings (spec 0014). */
const hubReposOf = (hub: string, settings: RepoSettings | null): HubRepo[] =>
  Object.entries(settings ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => ({
      name,
      path: `${hub}/repos/${name}`,
      baseBranch: s.baseBranch,
      preview: s.preview ?? null,
    }));

const toLine = (row: LineRow): Line => ({
  ...row,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

@Injectable()
export class ProjectsRepository {
  async list(db: Executor): Promise<Project[]> {
    const rows = await db.select().from(projects).orderBy(asc(projects.createdAt));
    return rows.map(toProject);
  }

  /** Work orders that are queued, on the line or waiting at a gate; locks the project row. */
  async lockAndCountActive(db: Executor, id: string): Promise<number | null> {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id))
      .for("update");
    if (!project) return null;
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.projectId, id),
          inArray(workOrders.status, ["queued", "running", "awaiting_approval"]),
        ),
      );
    return row?.count ?? 0;
  }

  /** Every run of the project with its worktree path (null once cleaned up). */
  async runWorktrees(
    db: Executor,
    id: string,
  ): Promise<{ runId: string; worktreePath: string; repo: string | null }[]> {
    const rows = await db
      .select({ runId: runs.id, worktreePath: runs.worktreePath, repo: runs.repo })
      .from(runs)
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .where(and(eq(workOrders.projectId, id), isNotNull(runs.worktreePath)));
    return rows.flatMap((r) =>
      r.worktreePath ? [{ runId: r.runId, worktreePath: r.worktreePath, repo: r.repo }] : [],
    );
  }

  async runIds(db: Executor, id: string): Promise<string[]> {
    const rows = await db
      .select({ runId: runs.id })
      .from(runs)
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .where(eq(workOrders.projectId, id));
    return rows.map((r) => r.runId);
  }

  /** Lines, work orders, runs, events, shifts and QA rows go with it (FK cascade). */
  async delete(db: Executor, id: string): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async find(db: Executor, id: string): Promise<Project | null> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    return row ? toProject(row) : null;
  }

  /** Idempotent on a client-supplied id: a replayed offline create returns the original. */
  async insert(
    db: Executor,
    values: {
      id?: string | undefined;
      name: string;
      repoPath: string;
      baseBranch: string;
      kind?: ProjectKind;
      repoSettings?: RepoSettings | null;
    },
  ): Promise<{ project: Project; created: boolean }> {
    const { id, ...rest } = values;
    const [row] = await db
      .insert(projects)
      .values(id ? { id, ...rest } : rest)
      .onConflictDoNothing({ target: projects.id })
      .returning();
    if (row) return { project: toProject(row), created: true };
    const existing = values.id ? await this.find(db, values.id) : null;
    if (!existing) throw new Error("project insert returned nothing");
    return { project: existing, created: false };
  }

  async findRouteMap(
    db: Executor,
    id: string,
  ): Promise<Pick<ProjectRow, "repoPath" | "baseBranch" | "routeMap" | "routeDiscovery"> | null> {
    const [row] = await db
      .select({
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        routeMap: projects.routeMap,
        routeDiscovery: projects.routeDiscovery,
      })
      .from(projects)
      .where(eq(projects.id, id));
    return row ?? null;
  }

  async setRouteMap(db: Executor, id: string, routeMap: RouteMap): Promise<boolean> {
    const rows = await db
      .update(projects)
      .set({ routeMap })
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    return rows.length > 0;
  }

  /** Adds settings for repos new to a hub; never overwrites an existing repo's entry. */
  async addRepoSettings(db: Executor, id: string, added: RepoSettings): Promise<void> {
    await db
      .update(projects)
      .set({
        repoSettings: sql`${JSON.stringify(added)}::jsonb || coalesce(${projects.repoSettings}, '{}'::jsonb)`,
      })
      .where(eq(projects.id, id));
  }

  /** Merges a patch into one hub repo's settings. */
  async updateRepoSettings(
    db: Executor,
    id: string,
    repo: string,
    patch: UpdateHubRepo,
  ): Promise<Project | null> {
    const [row] = await db
      .update(projects)
      .set({
        repoSettings: sql`jsonb_set(
          coalesce(${projects.repoSettings}, '{}'::jsonb),
          array[${repo}::text],
          coalesce(${projects.repoSettings} -> ${repo}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
        )`,
      })
      .where(eq(projects.id, id))
      .returning();
    return row ? toProject(row) : null;
  }

  async claudeAccountExists(db: Executor, id: string): Promise<boolean> {
    const [row] = await db
      .select({ id: claudeAccounts.id })
      .from(claudeAccounts)
      .where(eq(claudeAccounts.id, id));
    return row !== undefined;
  }

  async update(db: Executor, id: string, patch: UpdateProject): Promise<Project | null> {
    const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    return row ? toProject(row) : null;
  }

  async insertLine(
    db: Executor,
    projectId: string,
    stations: Station[],
    kind: LineKind = "build",
  ): Promise<void> {
    await db
      .insert(lines)
      .values({
        projectId,
        kind,
        name: kind === "review" ? "Review line" : "Default line",
        stations,
      })
      // Lazily seeded review lines can race (two first reviews at once).
      .onConflictDoNothing();
  }

  async updateLine(
    db: Executor,
    projectId: string,
    stations: Station[],
    kind: LineKind = "build",
  ): Promise<Line | null> {
    const [row] = await db
      .update(lines)
      .set({ stations })
      .where(and(eq(lines.projectId, projectId), eq(lines.kind, kind)))
      .returning();
    return row ? toLine(row) : null;
  }

  async stats(db: Executor, projectId: string): Promise<ProjectStats> {
    const [costRow] = await db
      .select({ costUsd: sql<number>`coalesce(sum(${stationRuns.costUsd}), 0)::float8` })
      .from(stationRuns)
      .innerJoin(runs, eq(runs.id, stationRuns.runId))
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .where(eq(workOrders.projectId, projectId));
    const [countRow] = await db
      .select({
        runs: sql<number>`count(${runs.id})::int`,
        done: sql<number>`count(${runs.id}) filter (where ${runs.status} = 'succeeded')::int`,
      })
      .from(runs)
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .where(eq(workOrders.projectId, projectId));
    return {
      projectId,
      costUsd: costRow?.costUsd ?? 0,
      runs: countRow?.runs ?? 0,
      done: countRow?.done ?? 0,
    };
  }

  async findLine(db: Executor, projectId: string, kind: LineKind = "build"): Promise<Line | null> {
    const [row] = await db
      .select()
      .from(lines)
      .where(and(eq(lines.projectId, projectId), eq(lines.kind, kind)));
    return row ? toLine(row) : null;
  }
}
