import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  NOTIFICATION_EXTERNAL_DEFAULTS,
  type Notification,
  type NotificationJob,
  type ServerEvent,
} from "@zastava/contracts";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import {
  backoffSeconds,
  clamp,
  NOTIFICATION_DEFINITIONS,
  renderJob,
  type RenderDeps,
  type WorkOrderContext,
} from "../src/modules/notifications/notification-definitions";
import { NotificationJobsProcessor } from "../src/modules/notifications/notification-jobs.processor";
import { NotificationsController } from "../src/modules/notifications/notifications.controller";
import type {
  ClaimedJob,
  NotificationsRepository,
} from "../src/modules/notifications/notifications.repository";
import { NotificationsService } from "../src/modules/notifications/notifications.service";

const WO = "8f0a5a2e-4a1b-4c55-9a43-2b7f8f0b1c01";
const PROJECT = "85156849-2497-47fa-a2bd-494c776f572b";

const workOrder: WorkOrderContext = {
  id: WO,
  projectId: PROJECT,
  title: "Add dark mode",
  prUrl: null,
  pullRequestNumber: null,
  stations: [{ key: "plan_gate", kind: "gate", name: "Approve plan", prompt: "" }],
};

const deps = (found: WorkOrderContext | null = workOrder): RenderDeps => ({
  workOrder: () => Promise.resolve(found),
});

describe("notification definitions", () => {
  it("renders a gate with the station's name and links the board", async () => {
    const rendered = await renderJob(
      { kind: "gate_waiting", payload: { workOrderId: WO, stationKey: "plan_gate" } },
      deps(),
    );
    expect(rendered).toEqual({
      title: "Needs you: Add dark mode",
      body: "Approve plan is waiting for your decision.",
      path: `/projects/${PROJECT}?view=board&wo=${WO}`,
      projectId: PROJECT,
      workOrderId: WO,
    });
  });

  it("links a review to its pull request", async () => {
    const rendered = await renderJob(
      { kind: "review_ready", payload: { workOrderId: WO, findings: 1 } },
      deps({ ...workOrder, pullRequestNumber: 42 }),
    );
    expect(rendered?.path).toBe(`/projects/${PROJECT}/pulls/assigned?pr=42`);
    expect(rendered?.body).toBe("1 finding; pick the ones to post.");
  });

  it("renders nothing when the work order is gone", async () => {
    const rendered = await renderJob(
      { kind: "run_failed", payload: { workOrderId: WO, reason: null } },
      deps(null),
    );
    expect(rendered).toBeNull();
  });

  it("renders every kind without throwing", async () => {
    const jobs: NotificationJob[] = [
      { kind: "gate_waiting", payload: { workOrderId: WO, stationKey: "unknown" } },
      { kind: "run_failed", payload: { workOrderId: WO, reason: "boom" } },
      { kind: "run_succeeded", payload: { workOrderId: WO } },
      { kind: "review_ready", payload: { workOrderId: WO, findings: 0 } },
      { kind: "ci_failed", payload: { workOrderId: WO, summary: "1 failed", link: null } },
      { kind: "ci_passed", payload: { workOrderId: WO, summary: "3 passed" } },
      { kind: "shift_handoff_ready", payload: { workOrderId: WO, number: 2 } },
      { kind: "shift_stuck", payload: { workOrderId: WO, number: 3 } },
      {
        kind: "knowledge_sync_failed",
        payload: { workOrderId: WO, sourceId: WO, name: "Handbook", error: "git: 128\nmore" },
      },
      { kind: "dispatcher_paused", payload: { reason: "5-hour usage 90%", resumesAt: null } },
    ];
    expect(jobs.map((j) => j.kind).toSorted()).toEqual(
      Object.keys(NOTIFICATION_DEFINITIONS).toSorted(),
    );
    for (const job of jobs) {
      const rendered = await renderJob(job, deps());
      expect(rendered?.title.length).toBeGreaterThan(0);
    }
  });

  it("clamps to the contract's limits", () => {
    const long = clamp({
      title: "t".repeat(500),
      body: "b".repeat(5_000),
      path: "/",
      projectId: null,
      workOrderId: null,
    });
    expect(long.title).toHaveLength(200);
    expect(long.body).toHaveLength(2_000);
  });

  it("backs off exponentially", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([2, 4, 8, 16]);
  });
});

const notification: Notification = {
  id: "0b8e3f5c-7d1a-4e0b-9f3a-1c2d3e4f5a6b",
  kind: "run_failed",
  title: "Run failed: Add dark mode",
  body: "boom",
  path: `/projects/${PROJECT}?view=board&wo=${WO}`,
  projectId: PROJECT,
  workOrderId: WO,
  readAt: null,
  createdAt: "2026-10-04T10:00:00.000Z",
};

function processorWith(claimed: ClaimedJob | null, stored: Notification = notification) {
  const repository = {
    claimNextJob: vi.fn(() => Promise.resolve(claimed)),
    workOrderContext: vi.fn(() => Promise.resolve(workOrder)),
    insert: vi.fn(() => Promise.resolve(stored)),
    completeJob: vi.fn(() => Promise.resolve()),
    failJob: vi.fn(() => Promise.resolve()),
    appendRunError: vi.fn(() => Promise.resolve({ runId: "run-1", seq: 7 })),
  };
  // A transaction whose savepoints run inline; enough to exercise the flow.
  const tx = { transaction: (work: (sp: unknown) => Promise<unknown>) => work(tx) };
  const database = {
    db: {},
    transaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
  };
  const published: ServerEvent[] = [];
  const events = { publish: vi.fn((e: ServerEvent) => Promise.resolve(void published.push(e))) };
  const settings = {
    get: vi.fn(() =>
      Promise.resolve({
        appUrl: "http://localhost:4800",
        notificationExternal: { ...NOTIFICATION_EXTERNAL_DEFAULTS, review_ready: false },
      }),
    ),
    broadcast: vi.fn(() =>
      Promise.resolve<{ channel: string; error: string | null }[]>([
        { channel: "slack", error: null },
      ]),
    ),
  };
  const processor = new NotificationJobsProcessor(
    {} as never,
    database as never,
    repository as unknown as NotificationsRepository,
    events as never,
    settings as never,
  );
  return { processor, repository, published, settings };
}

const job = (attempts = 0): ClaimedJob => ({
  id: "job-1",
  attempts,
  job: { kind: "run_failed", payload: { workOrderId: WO, reason: "boom" } },
  parseError: null,
});

describe("NotificationJobsProcessor", () => {
  it("reports an empty queue", async () => {
    const { processor } = processorWith(null);
    expect(await processor.processNext()).toBe(false);
  });

  it("stores, completes, pushes over SSE and fans out an external kind", async () => {
    const { processor, repository, published, settings } = processorWith(job());
    expect(await processor.processNext()).toBe(true);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      "run_failed",
      expect.objectContaining({ title: "Run failed: Add dark mode" }),
    );
    expect(repository.completeJob).toHaveBeenCalledWith(expect.anything(), "job-1");
    expect(published).toEqual([{ type: "notification", notification }]);
    expect(settings.broadcast).toHaveBeenCalledWith({
      title: notification.title,
      body: notification.body,
      url: `http://localhost:4800${notification.path}`,
    });
  });

  it("logs a failed channel on the work order's run", async () => {
    const { processor, repository, published, settings } = processorWith(job());
    settings.broadcast.mockResolvedValueOnce([{ channel: "slack", error: "HTTP 404" }]);
    await processor.processNext();
    expect(repository.appendRunError).toHaveBeenCalledWith(
      {},
      WO,
      "Notification via slack failed: HTTP 404",
    );
    expect(published).toContainEqual({ type: "run_event", runId: "run-1", seq: 7 });
  });

  it("does not fan out a bell-only kind", async () => {
    const { processor, settings, published } = processorWith(
      { ...job(), job: { kind: "ci_passed", payload: { workOrderId: WO, summary: "ok" } } },
      { ...notification, kind: "ci_passed" },
    );
    await processor.processNext();
    expect(published).toHaveLength(1);
    expect(settings.broadcast).not.toHaveBeenCalled();
  });

  it("honours a kind turned off in Settings", async () => {
    const { processor, settings } = processorWith(
      { ...job(), job: { kind: "review_ready", payload: { workOrderId: WO, findings: 0 } } },
      { ...notification, kind: "review_ready" },
    );
    await processor.processNext();
    expect(settings.broadcast).not.toHaveBeenCalled();
  });

  it("retries a failed render with backoff, then gives up", async () => {
    const first = processorWith(job(0));
    first.repository.workOrderContext.mockRejectedValueOnce(new Error("db down"));
    await first.processor.processNext();
    expect(first.repository.failJob).toHaveBeenCalledWith(expect.anything(), "job-1", "db down", 2);
    expect(first.published).toEqual([]);

    const last = processorWith(job(4));
    last.repository.workOrderContext.mockRejectedValueOnce(new Error("db down"));
    await last.processor.processNext();
    expect(last.repository.failJob).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      "db down",
      null,
    );
  });

  it("fails an unparseable job for good", async () => {
    const { processor, repository } = processorWith({
      id: "job-1",
      attempts: 0,
      job: null,
      parseError: "bad payload",
    });
    await processor.processNext();
    expect(repository.failJob).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      "bad payload",
      null,
    );
  });
});

describe("NotificationsController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function start(rows: Notification[]) {
    const repository = {
      list: vi.fn((_db: unknown, limit: number) => Promise.resolve(rows.slice(0, limit))),
      unreadCount: vi.fn(() => Promise.resolve(rows.filter((r) => !r.readAt).length)),
      markRead: vi.fn(() => Promise.resolve()),
    };
    const events = { publish: vi.fn(() => Promise.resolve()) };
    const module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: new NotificationsService(
            { db: {} } as never,
            repository as unknown as NotificationsRepository,
            events as never,
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    return { http: request(app.getHttpServer()), repository, events };
  }

  it("pages newest first with a cursor and the unread count", async () => {
    const rows = [1, 2, 3].map((n) => ({
      ...notification,
      id: `0b8e3f5c-7d1a-4e0b-9f3a-1c2d3e4f5a6${n}`,
    }));
    const { http } = await start(rows);
    const res = await http.get("/notifications?limit=2").expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.unreadCount).toBe(3);
    expect(res.body.nextCursor).toBe(rows[1]!.id);
  });

  it("marks all read and tells other tabs", async () => {
    const { http, repository, events } = await start([]);
    await http.post("/notifications/read").send({ all: true }).expect(200, { unreadCount: 0 });
    expect(repository.markRead).toHaveBeenCalledWith({}, null);
    expect(events.publish).toHaveBeenCalledWith({
      type: "invalidate",
      collection: "notifications",
    });
  });

  it("rejects a body with neither ids nor all", async () => {
    const { http } = await start([]);
    const res = await http.post("/notifications/read").send({}).expect(400);
    expect(res.body.error.code).toBe("http_error");
  });
});
