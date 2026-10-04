import {
  NOTIFICATION_JOBS_CHANNEL,
  type NotificationJob,
  notificationJobSchema,
} from "@zastava/contracts";
import { type Executor, notificationJobs } from "@zastava/db";
import { like, sql } from "drizzle-orm";

/**
 * Queues a notification (spec 0011). The only way anything becomes one: the
 * API's job processor renders, stores, pushes and fans it out.
 *
 * Pass the open transaction as `db` to commit the job with the state change
 * (transactional outbox); NOTIFY is delivered on commit. Idempotent on
 * `dedupeKey`, so a retried activity enqueues once.
 */
export async function enqueueNotification(
  db: Executor,
  job: NotificationJob,
  dedupeKey: string,
  options: {
    /**
     * Record the key as already handled, without notifying: a poller's first
     * look (everything already there is not news) uses it as a baseline.
     */
    silent?: boolean;
  } = {},
): Promise<void> {
  const parsed = notificationJobSchema.parse(job);
  await db
    .insert(notificationJobs)
    .values({
      kind: parsed.kind,
      payload: parsed.payload,
      dedupeKey,
      ...(options.silent ? { status: "done" as const, processedAt: new Date() } : {}),
    })
    .onConflictDoNothing({ target: notificationJobs.dedupeKey });
  if (!options.silent) {
    await db.execute(sql`SELECT pg_notify(${NOTIFICATION_JOBS_CHANNEL}, '')`);
  }
}

/** Whether any job was ever queued under `prefix` (a poller's "have I looked before?"). */
export async function hasNotificationJobs(db: Executor, prefix: string): Promise<boolean> {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const [row] = await db
    .select({ id: notificationJobs.id })
    .from(notificationJobs)
    .where(like(notificationJobs.dedupeKey, `${escaped}%`))
    .limit(1);
  return row !== undefined;
}
