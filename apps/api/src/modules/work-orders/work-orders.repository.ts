import { Injectable } from "@nestjs/common";
import type { NeedsYouItem, UpdateWorkOrder, WorkOrder } from "@zastava/contracts";
import { type Executor, projects, runs, workOrders } from "@zastava/db";
import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { iso } from "../../common/mappers";

type WorkOrderRow = typeof workOrders.$inferSelect;
type WorkOrderPatch = Partial<Omit<WorkOrderRow, "id" | "projectId" | "createdAt" | "updatedAt">>;

const toWorkOrder = (row: WorkOrderRow): WorkOrder => ({
  ...row,
  queuedAt: iso(row.queuedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

@Injectable()
export class WorkOrdersRepository {
  async list(db: Executor, projectId: string): Promise<WorkOrder[]> {
    const rows = await db
      .select()
      .from(workOrders)
      // Review work orders live with their pull request, not on the board.
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.kind, "build")))
      .orderBy(asc(workOrders.position), asc(workOrders.createdAt));
    return rows.map(toWorkOrder);
  }

  /** Every work order waiting at a gate, oldest first. */
  listAwaitingApproval(db: Executor): Promise<NeedsYouItem[]> {
    return this.listBrief(db, "awaiting_approval");
  }

  /** Orders with an agent at work right now (what quitting the desktop app would cut). */
  listRunning(db: Executor): Promise<NeedsYouItem[]> {
    return this.listBrief(db, "running");
  }

  private async listBrief(
    db: Executor,
    status: "awaiting_approval" | "running",
  ): Promise<NeedsYouItem[]> {
    const rows = await db
      .select({
        workOrderId: workOrders.id,
        projectId: workOrders.projectId,
        projectName: projects.name,
        title: workOrders.title,
        since: workOrders.updatedAt,
      })
      .from(workOrders)
      .innerJoin(projects, eq(projects.id, workOrders.projectId))
      .where(eq(workOrders.status, status))
      .orderBy(asc(workOrders.updatedAt));
    return rows.map((r) => ({ ...r, since: iso(r.since) }));
  }

  async find(db: Executor, id: string): Promise<WorkOrder | null> {
    const [row] = await db.select().from(workOrders).where(eq(workOrders.id, id));
    return row ? toWorkOrder(row) : null;
  }

  /** Locks the order for a delete; null when it's already gone. */
  async lockForDelete(
    db: Executor,
    id: string,
  ): Promise<{ status: WorkOrder["status"]; repoPath: string; kind: "repo" | "hub" } | null> {
    const [row] = await db
      .select({ status: workOrders.status, repoPath: projects.repoPath, kind: projects.kind })
      .from(workOrders)
      .innerJoin(projects, eq(projects.id, workOrders.projectId))
      .where(eq(workOrders.id, id))
      .for("update", { of: workOrders });
    return row ?? null;
  }

  /** Every run of the order with its worktree, if one was made. */
  async runFiles(
    db: Executor,
    id: string,
  ): Promise<{ runId: string; worktreePath: string | null; repo: string | null }[]> {
    return db
      .select({ runId: runs.id, worktreePath: runs.worktreePath, repo: runs.repo })
      .from(runs)
      .where(eq(runs.workOrderId, id));
  }

  /** Runs, events, shifts and QA rows go with it (FK cascade). */
  async delete(db: Executor, id: string): Promise<void> {
    await db.delete(workOrders).where(eq(workOrders.id, id));
  }

  /** Moves every backlog order of a project into the queue, oldest position first. */
  async enqueueBacklog(db: Executor, projectId: string, mode: "asap" | "night"): Promise<number> {
    const rows = await db
      .update(workOrders)
      .set({ status: "queued", queueMode: mode, queuedAt: new Date() })
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.status, "backlog")))
      .returning({ id: workOrders.id });
    return rows.length;
  }

  /** The project a work order belongs to (or would): kind and path, for hub checks. */
  async projectOf(
    db: Executor,
    projectId: string,
  ): Promise<{ kind: "repo" | "hub"; repoPath: string } | null> {
    const [row] = await db
      .select({ kind: projects.kind, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row ?? null;
  }

  /** The chain that follows a work order, in order (a split's followers). */
  async followers(db: Executor, id: string): Promise<WorkOrder[]> {
    const chain: WorkOrder[] = [];
    let previous = id;
    for (let i = 0; i < 20; i++) {
      const [row] = await db.select().from(workOrders).where(eq(workOrders.followsId, previous));
      if (!row) break;
      chain.push(toWorkOrder(row));
      previous = row.id;
    }
    return chain;
  }

  /**
   * Queues (asap) followers that never ran once their predecessor is done
   * (delivered after a succeeded run). Followers of running or failed work wait.
   */
  async enqueueReadyFollowers(db: Executor): Promise<number> {
    const rows = await db
      .update(workOrders)
      .set({ status: "queued", queueMode: "asap", queuedAt: new Date() })
      .where(
        and(
          eq(workOrders.status, "backlog"),
          isNull(workOrders.currentRunId),
          sql`${workOrders.followsId} IN (SELECT ${workOrders.id} FROM ${workOrders} WHERE ${workOrders.status} = 'done')`,
        ),
      )
      .returning({ id: workOrders.id });
    return rows.length;
  }

  /** Oldest first: the dispatcher's FIFO. */
  async listQueued(db: Executor): Promise<WorkOrder[]> {
    const rows = await db
      .select()
      .from(workOrders)
      .where(eq(workOrders.status, "queued"))
      .orderBy(asc(workOrders.queuedAt), asc(workOrders.position));
    return rows.map(toWorkOrder);
  }

  async countByStatus(db: Executor, statuses: WorkOrder["status"][]): Promise<number> {
    const rows = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(inArray(workOrders.status, statuses));
    return rows.length;
  }

  async nextPosition(db: Executor, projectId: string): Promise<number> {
    const [row] = await db
      .select({ value: max(workOrders.position) })
      .from(workOrders)
      .where(eq(workOrders.projectId, projectId));
    return (row?.value ?? 0) + 1;
  }

  /** Idempotent on a client-supplied id so an offline create can be replayed safely. */
  async insert(
    db: Executor,
    values: {
      id?: string | undefined;
      projectId: string;
      title: string;
      description: string;
      position: number;
      repo?: string | null | undefined;
      followsId?: string | null | undefined;
    },
  ): Promise<WorkOrder> {
    const { id, ...rest } = values;
    const [row] = await db
      .insert(workOrders)
      .values(id ? { id, ...rest } : rest)
      .onConflictDoNothing({ target: workOrders.id })
      .returning();
    if (row) return toWorkOrder(row);
    const existing = id ? await this.find(db, id) : null;
    if (!existing) throw new Error("work order insert returned nothing");
    return existing;
  }

  async update(
    db: Executor,
    id: string,
    patch: UpdateWorkOrder | WorkOrderPatch,
  ): Promise<WorkOrder | null> {
    const [row] = await db.update(workOrders).set(patch).where(eq(workOrders.id, id)).returning();
    return row ? toWorkOrder(row) : null;
  }
}
