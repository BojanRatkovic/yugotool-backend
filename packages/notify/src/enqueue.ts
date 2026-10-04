import {
  NOTIFICATION_JOBS_CHANNEL,
  type NotificationJob,
  notificationJobSchema,
} from "@zastava/contracts";
import { type Executor, notificationJobs } from "@zastava/db";
import { sql } from "drizzle-orm";

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
): Promise<void> {
  const parsed = notificationJobSchema.parse(job);
  await db
    .insert(notificationJobs)
    .values({ kind: parsed.kind, payload: parsed.payload, dedupeKey })
    .onConflictDoNothing({ target: notificationJobs.dedupeKey });
  await db.execute(sql`SELECT pg_notify(${NOTIFICATION_JOBS_CHANNEL}, '')`);
}
