import { Injectable } from "@nestjs/common";
import {
  type Notification,
  type NotificationJob,
  notificationJobSchema,
  notificationKindSchema,
} from "@zastava/contracts";
import { type Executor, lines, notificationJobs, notifications, workOrders } from "@zastava/db";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { iso } from "../../common/mappers";
import type { RenderedNotification, WorkOrderContext } from "./notification-definitions";

type NotificationRow = typeof notifications.$inferSelect;

const toNotification = (row: NotificationRow): Notification => ({
  id: row.id,
  kind: notificationKindSchema.parse(row.kind),
  title: row.title,
  body: row.body,
  path: row.path,
  projectId: row.projectId,
  workOrderId: row.workOrderId,
  readAt: iso(row.readAt),
  createdAt: iso(row.createdAt),
});

export interface ClaimedJob {
  id: string;
  attempts: number;
  /** Null when the stored kind/payload no longer parses; the job then fails for good. */
  job: NotificationJob | null;
  parseError: string | null;
}

@Injectable()
export class NotificationsRepository {
  // ── Jobs ──────────────────────────────────────────────────────────────────

  /**
   * Locks the oldest due pending job. SKIP LOCKED lets several processors
   * (API instances) drain the queue without ever taking the same job.
   */
  async claimNextJob(tx: Executor): Promise<ClaimedJob | null> {
    const [row] = await tx
      .select({
        id: notificationJobs.id,
        kind: notificationJobs.kind,
        payload: notificationJobs.payload,
        attempts: notificationJobs.attempts,
      })
      .from(notificationJobs)
      .where(
        and(eq(notificationJobs.status, "pending"), sql`${notificationJobs.runAfter} <= now()`),
      )
      .orderBy(notificationJobs.runAfter)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const parsed = notificationJobSchema.safeParse({ kind: row.kind, payload: row.payload });
    return {
      id: row.id,
      attempts: row.attempts,
      job: parsed.success ? parsed.data : null,
      parseError: parsed.success ? null : parsed.error.message,
    };
  }

  async completeJob(tx: Executor, id: string): Promise<void> {
    await tx
      .update(notificationJobs)
      .set({ status: "done", processedAt: new Date(), lastError: null })
      .where(eq(notificationJobs.id, id));
  }

  /** `retryInSeconds` null = out of attempts: the job fails for good. */
  async failJob(
    tx: Executor,
    id: string,
    error: string,
    retryInSeconds: number | null,
  ): Promise<void> {
    await tx
      .update(notificationJobs)
      .set({
        attempts: sql`${notificationJobs.attempts} + 1`,
        lastError: error.slice(0, 2_000),
        ...(retryInSeconds === null
          ? { status: "failed" as const, processedAt: new Date() }
          : { runAfter: sql`now() + make_interval(secs => ${retryInSeconds})` }),
      })
      .where(eq(notificationJobs.id, id));
  }

  async workOrderContext(db: Executor, id: string): Promise<WorkOrderContext | null> {
    const [row] = await db
      .select({
        id: workOrders.id,
        projectId: workOrders.projectId,
        title: workOrders.title,
        prUrl: workOrders.prUrl,
        pullRequest: workOrders.pullRequest,
        stations: lines.stations,
      })
      .from(workOrders)
      // The work order's own line: a review's gates live on the review line.
      .leftJoin(
        lines,
        and(
          eq(lines.projectId, workOrders.projectId),
          sql`${lines.kind}::text = ${workOrders.kind}::text`,
        ),
      )
      .where(eq(workOrders.id, id));
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      prUrl: row.prUrl,
      pullRequestNumber: row.pullRequest?.number ?? null,
      stations: row.stations ?? [],
    };
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  /** One notification per job: a replayed job returns null instead of a duplicate. */
  async insert(
    tx: Executor,
    jobId: string,
    kind: NotificationJob["kind"],
    rendered: RenderedNotification,
  ): Promise<Notification | null> {
    const [row] = await tx
      .insert(notifications)
      .values({ jobId, kind, ...rendered })
      .onConflictDoNothing({ target: notifications.jobId })
      .returning();
    return row ? toNotification(row) : null;
  }

  /** Newest first; `before` is the last id of the previous page. */
  async list(db: Executor, limit: number, before?: string): Promise<Notification[]> {
    const cursor = before
      ? sql`(${notifications.createdAt}, ${notifications.id}) < (SELECT created_at, id FROM ${notifications} WHERE id = ${before})`
      : undefined;
    const rows = await db
      .select()
      .from(notifications)
      .where(cursor)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
    return rows.map(toNotification);
  }

  async unreadCount(db: Executor): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(isNull(notifications.readAt));
    return row?.count ?? 0;
  }

  /** Marks `ids` read, or every unread one when `ids` is null. Already-read rows keep their time. */
  async markRead(db: Executor, ids: string[] | null): Promise<void> {
    if (ids?.length === 0) return;
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
  }

  /** Housekeeping: read notifications after 30 days, finished jobs after 7 (failed: 30). */
  async sweep(db: Executor): Promise<void> {
    await db
      .delete(notifications)
      .where(
        and(
          sql`${notifications.readAt} IS NOT NULL`,
          lt(notifications.createdAt, sql`now() - interval '30 days'`),
        ),
      );
    await db.delete(notificationJobs).where(
      sql`(${notificationJobs.status} = 'done' AND ${notificationJobs.processedAt} < now() - interval '7 days')
          OR (${notificationJobs.status} = 'failed' AND ${notificationJobs.processedAt} < now() - interval '30 days')`,
    );
  }
}
