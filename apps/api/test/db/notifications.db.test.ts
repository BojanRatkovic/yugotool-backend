import { createDbClient, type DbClient, notificationJobs, notifications } from "@zastava/db";
import { enqueueNotification } from "@zastava/notify";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationsRepository } from "../../src/modules/notifications/notifications.repository";
import { SettingsService } from "../../src/modules/settings/settings.service";
import { testDatabaseUrl } from "./test-database";

const PROJECT = "85156849-2497-47fa-a2bd-494c776f572b";
const WO = "8f0a5a2e-4a1b-4c55-9a43-2b7f8f0b1c01";

let client: DbClient;
const repository = new NotificationsRepository();

const gate = (n: number) =>
  ({ kind: "gate_waiting", payload: { workOrderId: WO, stationKey: `s${n}` } }) as const;

beforeAll(async () => {
  client = createDbClient(testDatabaseUrl());
  await client.db.execute(
    sql`INSERT INTO projects (id, name, repo_path) VALUES (${PROJECT}, 'demo', '/tmp/demo')`,
  );
  await client.db.execute(
    sql`INSERT INTO work_orders (id, project_id, title) VALUES (${WO}, ${PROJECT}, 'Add dark mode')`,
  );
});

afterAll(async () => {
  await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE notification_jobs, notifications`);
});

/** Claims, renders a fixed notification and completes — the processor's happy path. */
async function processOne(at?: Date): Promise<boolean> {
  return client.db.transaction(async (tx) => {
    const claimed = await repository.claimNextJob(tx);
    if (!claimed?.job) return false;
    const stored = await repository.insert(tx, claimed.id, claimed.job.kind, {
      title: `t ${claimed.id}`,
      body: "b",
      path: "/",
      projectId: PROJECT,
      workOrderId: WO,
    });
    if (stored && at) {
      await tx.update(notifications).set({ createdAt: at }).where(eq(notifications.id, stored.id));
    }
    await repository.completeJob(tx, claimed.id);
    return true;
  });
}

describe("notification jobs on Postgres", () => {
  it("enqueues once per dedupe key", async () => {
    await enqueueNotification(client.db, gate(1), "same");
    await enqueueNotification(client.db, gate(2), "same");
    const rows = await client.db.select().from(notificationJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ workOrderId: WO, stationKey: "s1" });
  });

  it("rejects a payload that does not match its kind", async () => {
    await expect(
      enqueueNotification(client.db, { kind: "run_succeeded", payload: {} } as never, "bad"),
    ).rejects.toThrow();
  });

  it("never hands the same job to two concurrent claimers", async () => {
    await enqueueNotification(client.db, gate(1), "a");
    await enqueueNotification(client.db, gate(2), "b");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstId: string | undefined;
    let claimedFirst!: () => void;
    const firstClaimed = new Promise<void>((r) => (claimedFirst = r));
    const first = client.db.transaction(async (tx) => {
      firstId = (await repository.claimNextJob(tx))?.id;
      claimedFirst();
      await held;
    });
    await firstClaimed;
    const second = await client.db.transaction(async (tx) => {
      const a = await repository.claimNextJob(tx);
      return a?.id;
    });
    release();
    await first;
    expect(firstId).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(firstId);
  });

  it("skips a locked job rather than waiting for it", async () => {
    await enqueueNotification(client.db, gate(1), "only");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let claimedFirst!: () => void;
    const firstClaimed = new Promise<void>((r) => (claimedFirst = r));
    const first = client.db.transaction(async (tx) => {
      await repository.claimNextJob(tx);
      claimedFirst();
      await held;
    });
    await firstClaimed;
    const second = await client.db.transaction((tx) => repository.claimNextJob(tx));
    release();
    await first;
    expect(second).toBeNull();
  });

  it("delays a retry and fails for good when out of attempts", async () => {
    await enqueueNotification(client.db, gate(1), "retry");
    await client.db.transaction(async (tx) => {
      const claimed = await repository.claimNextJob(tx);
      await repository.failJob(tx, claimed!.id, "boom", 60);
    });
    // Not due for a minute: nothing to claim.
    expect(await client.db.transaction((tx) => repository.claimNextJob(tx))).toBeNull();
    let [row] = await client.db.select().from(notificationJobs);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });

    await client.db.update(notificationJobs).set({ runAfter: new Date(0) });
    await client.db.transaction(async (tx) => {
      const claimed = await repository.claimNextJob(tx);
      expect(claimed?.attempts).toBe(1);
      await repository.failJob(tx, claimed!.id, "still", null);
    });
    [row] = await client.db.select().from(notificationJobs);
    expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "still" });
  });

  it("stores one notification per job", async () => {
    await enqueueNotification(client.db, gate(1), "one");
    const [job] = await client.db.select().from(notificationJobs);
    const rendered = { title: "t", body: "b", path: "/", projectId: null, workOrderId: null };
    expect(await repository.insert(client.db, job!.id, "gate_waiting", rendered)).not.toBeNull();
    expect(await repository.insert(client.db, job!.id, "gate_waiting", rendered)).toBeNull();
  });
});

describe("notifications on Postgres", () => {
  it("walks pages newest first without gaps or repeats", async () => {
    // Same timestamp for several rows: the id breaks the tie.
    const same = new Date("2026-10-04T10:00:00.123456Z");
    for (let i = 0; i < 7; i++) {
      await enqueueNotification(client.db, gate(i), `page:${i}`);
      await processOne(i < 4 ? same : new Date(Date.UTC(2026, 9, 4, 11, i)));
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await repository.list(client.db, 3, before);
      seen.push(...page.map((n) => n.id));
      if (page.length < 3) break;
      before = page.at(-1)!.id;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const all = await repository.list(client.db, 50);
    expect(all.map((n) => n.id)).toEqual(seen);
  });

  it("counts unread and marks some or all read", async () => {
    for (let i = 0; i < 3; i++) {
      await enqueueNotification(client.db, gate(i), `read:${i}`);
      await processOne();
    }
    const [first] = await repository.list(client.db, 1);
    expect(await repository.unreadCount(client.db)).toBe(3);
    await repository.markRead(client.db, [first!.id]);
    expect(await repository.unreadCount(client.db)).toBe(2);
    await repository.markRead(client.db, null);
    expect(await repository.unreadCount(client.db)).toBe(0);
  });

  it("sweeps old read notifications and done jobs, keeps unread ones", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);
    for (let i = 0; i < 2; i++) {
      await enqueueNotification(client.db, gate(i), `sweep:${i}`);
      await processOne(old);
    }
    const [newest] = await repository.list(client.db, 1);
    await repository.markRead(client.db, [newest!.id]);
    await client.db.update(notificationJobs).set({ processedAt: old });
    await repository.sweep(client.db);
    const left = await repository.list(client.db, 10);
    expect(left).toHaveLength(1);
    expect(left[0]?.readAt).toBeNull();
    // Its job is gone; the notification outlives it.
    expect(await client.db.select().from(notificationJobs)).toHaveLength(0);
    const [row] = await client.db.select().from(notifications);
    expect(row?.jobId).toBeNull();
  });

  it("loads a work order's context with its own line", async () => {
    const context = await repository.workOrderContext(client.db, WO);
    expect(context).toMatchObject({ id: WO, projectId: PROJECT, title: "Add dark mode" });
    expect(await repository.workOrderContext(client.db, PROJECT)).toBeNull();
  });
});

describe("notification channel settings on Postgres", () => {
  it("fills defaults and merges a patch into the stored overrides", async () => {
    const service = new SettingsService(
      { get: () => undefined } as never,
      { db: client.db } as never,
      { publish: () => Promise.resolve() } as never,
    );
    const before = await service.get();
    expect(before.notificationExternal).toMatchObject({ run_failed: true, ci_passed: false });
    await service.update({ notificationExternal: { ci_passed: true } });
    await service.update({ notificationExternal: { run_failed: false } });
    const after = await service.get();
    expect(after.notificationExternal).toMatchObject({
      ci_passed: true,
      run_failed: false,
      gate_waiting: true,
    });
  });
});
