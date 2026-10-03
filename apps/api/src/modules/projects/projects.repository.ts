import { Injectable } from "@nestjs/common";
import type {
  Line,
  Project,
  ProjectStats,
  RouteMap,
  Station,
  UpdateProject,
} from "@zastava/contracts";
import { type Executor, lines, projects, runs, stationRuns, workOrders } from "@zastava/db";
import { asc, eq, sql } from "drizzle-orm";
import { iso } from "../../common/mappers";

type ProjectRow = typeof projects.$inferSelect;
type LineRow = typeof lines.$inferSelect;

const toProject = ({
  routeMap: _map,
  routeDiscovery: _discovery,
  ...row
}: ProjectRow): Project => ({
  ...row,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

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

  async find(db: Executor, id: string): Promise<Project | null> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    return row ? toProject(row) : null;
  }

  /** Idempotent on a client-supplied id: a replayed offline create returns the original. */
  async insert(
    db: Executor,
    values: { id?: string | undefined; name: string; repoPath: string; baseBranch: string },
  ): Promise<{ project: Project; created: boolean }> {
    const [row] = await db
      .insert(projects)
      .values(
        values.id
          ? values
          : { name: values.name, repoPath: values.repoPath, baseBranch: values.baseBranch },
      )
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

  async update(db: Executor, id: string, patch: UpdateProject): Promise<Project | null> {
    const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    return row ? toProject(row) : null;
  }

  async insertLine(db: Executor, projectId: string, stations: Station[]): Promise<void> {
    await db.insert(lines).values({ projectId, name: "Default line", stations });
  }

  async updateLine(db: Executor, projectId: string, stations: Station[]): Promise<Line | null> {
    const [row] = await db
      .update(lines)
      .set({ stations })
      .where(eq(lines.projectId, projectId))
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

  async findLine(db: Executor, projectId: string): Promise<Line | null> {
    const [row] = await db.select().from(lines).where(eq(lines.projectId, projectId));
    return row ? toLine(row) : null;
  }
}
