import { Injectable } from "@nestjs/common";
import type { NeedsYouItem, UpdateWorkOrder, WorkOrder } from "@zastava/contracts";
import { type Executor, projects, workOrders } from "@zastava/db";
import { and, asc, eq, inArray, max } from "drizzle-orm";
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
      .where(eq(workOrders.projectId, projectId))
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

  /** Moves every backlog order of a project into the queue, oldest position first. */
  async enqueueBacklog(db: Executor, projectId: string, mode: "asap" | "night"): Promise<number> {
    const rows = await db
      .update(workOrders)
      .set({ status: "queued", queueMode: mode, queuedAt: new Date() })
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.status, "backlog")))
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
