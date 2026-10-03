import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ProjectRemote, ReviewPullRequest } from "@zastava/contracts";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { DatabaseService } from "../src/core/database/database.service";
import { EventsService } from "../src/core/events/events.service";
import { TEMPORAL_CLIENT } from "../src/core/temporal/temporal.module";
import { ProjectsService } from "../src/modules/projects/projects.service";
import { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import {
  PullRequestReviewsRepository,
  type ReviewRow,
} from "../src/modules/pull-requests/pull-request-reviews.repository";
import { PullRequestReviewsService } from "../src/modules/pull-requests/pull-request-reviews.service";
import { PullRequestWritesService } from "../src/modules/pull-requests/pull-request-writes.service";
import { PullRequestsController } from "../src/modules/pull-requests/pull-requests.controller";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";
import { FakeGithub } from "./pull-requests-fake-github";

const PROJECT = "85156849-2497-47fa-a2bd-494c776f572b";
const BASE = `/projects/${PROJECT}/pull-requests/42/zastava-review`;
const HEAD = "a".repeat(40);
const GITHUB: ProjectRemote = {
  origin: "git@github.com:acme/app.git",
  github: true,
  ghLoggedIn: true,
  prPossible: true,
  reason: null,
};

const snapshot = (patch: Record<string, unknown> = {}) => ({
  repository: {
    pullRequest: {
      number: 42,
      title: "Add paging",
      url: "https://github.com/acme/app/pull/42",
      body: "Pages the **list**.",
      state: "OPEN",
      headRefName: "feature/paging",
      headRefOid: HEAD,
      baseRefName: "main",
      baseRefOid: "b".repeat(40),
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: "src/a.ts",
            line: 3,
            comments: { nodes: [{ body: "Why not a map?", author: { login: "ana" } }] },
          },
          {
            isResolved: true,
            path: "src/b.ts",
            line: 9,
            comments: { nodes: [{ body: "done", author: null }] },
          },
        ],
      },
      ...patch,
    },
  },
});

/** In-memory stand-in for the reviews repository (no Postgres in API tests). */
class MemoryReviews {
  rows = new Map<
    string,
    ReviewRow & { projectId: string; title: string; status: "running" | "done" | "failed" }
  >();

  private forPr(projectId: string, number: number) {
    return [...this.rows.values()].filter(
      (r) => r.projectId === projectId && r.pullRequest.number === number,
    );
  }
  latest = vi.fn(async (_db: unknown, projectId: string, number: number) => {
    return this.forPr(projectId, number).at(-1) ?? null;
  });
  find = vi.fn(async (_db: unknown, id: string) => this.rows.get(id) ?? null);
  exists = vi.fn(async (_db: unknown, id: string) => this.rows.has(id));
  isRunning = vi.fn(async (_db: unknown, projectId: string, number: number) =>
    this.forPr(projectId, number).some((r) => r.status === "running"),
  );
  lastReviewedHead = vi.fn(async (_db: unknown, projectId: string, number: number) => {
    return (
      this.forPr(projectId, number).findLast((r) => r.status === "done")?.pullRequest.headOid ??
      null
    );
  });
  insertRunning = vi.fn(
    async (
      _db: unknown,
      values: {
        id?: string | undefined;
        projectId: string;
        title: string;
        description: string;
        pullRequest: ReviewPullRequest;
      },
    ) => {
      const workOrderId = values.id ?? crypto.randomUUID();
      const runId = crypto.randomUUID();
      this.rows.set(workOrderId, {
        workOrderId,
        runId,
        runStatus: "running",
        pullRequest: values.pullRequest,
        costUsd: 0,
        verdict: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        projectId: values.projectId,
        title: values.title,
        status: "running",
      });
      return { workOrderId, runId, workflowId: `run-${runId}` };
    },
  );
  markFailed = vi.fn(async (_db: unknown, workOrderId: string) => {
    const row = this.rows.get(workOrderId);
    if (row) this.rows.set(workOrderId, { ...row, status: "failed", runStatus: "failed" });
  });

  finish(workOrderId: string) {
    const row = this.rows.get(workOrderId);
    if (row) this.rows.set(workOrderId, { ...row, status: "done", runStatus: "succeeded" });
  }
}

let app: INestApplication | undefined;

async function start(opts: { temporalFails?: boolean } = {}) {
  const github = new FakeGithub();
  github.answers.PrReviewSnapshot = snapshot();
  const reviews = new MemoryReviews();
  const temporal = {
    workflow: {
      start: vi.fn(async () => {
        if (opts.temporalFails) throw new Error("temporal is down");
        return {};
      }),
    },
  };
  const events = { publish: vi.fn(async () => undefined) };
  const projects = {
    remote: vi.fn(async () => GITHUB),
    getReviewLine: vi.fn(async () => ({})),
  };
  const module = await Test.createTestingModule({
    controllers: [PullRequestsController],
    providers: [
      PullRequestsService,
      PullRequestWritesService,
      PullRequestReviewsService,
      { provide: PullRequestReviewsRepository, useValue: reviews },
      { provide: GithubClient, useValue: github },
      { provide: ProjectsService, useValue: projects },
      { provide: EventsService, useValue: events },
      { provide: TEMPORAL_CLIENT, useValue: temporal },
      {
        provide: DatabaseService,
        useValue: { db: {}, transaction: (work: (tx: unknown) => unknown) => work({}) },
      },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { github, reviews, temporal, events, projects, http: request(app.getHttpServer()) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("ZASTAVA review API", () => {
  it("has no review before the first one", async () => {
    const { http } = await start();
    expect((await http.get(BASE).expect(200)).body).toEqual({ review: null });
  });

  it("freezes the PR's head and starts reviewRun", async () => {
    const { http, temporal, projects, events } = await start();
    const res = await http.post(BASE).send({}).expect(201);
    expect(res.body).toMatchObject({
      status: "running",
      stale: false,
      verdict: null,
      pullRequest: {
        number: 42,
        headOid: HEAD,
        baseRefName: "main",
        sinceOid: null,
        posted: [],
        openThreads: [{ path: "src/a.ts", line: 3, author: "ana", body: "Why not a map?" }],
      },
    });
    expect(projects.getReviewLine).toHaveBeenCalledWith(PROJECT);
    expect(temporal.workflow.start).toHaveBeenCalledWith(
      "reviewRun",
      expect.objectContaining({
        workflowId: `run-${res.body.runId}`,
        args: [{ runId: res.body.runId, workOrderId: res.body.workOrderId }],
      }),
    );
    expect(events.publish).toHaveBeenCalledWith({ type: "invalidate", collection: "reviews" });
  });

  it("is 409 review_running while a review of the PR runs", async () => {
    const { http, temporal } = await start();
    await http.post(BASE).send({}).expect(201);
    const res = await http.post(BASE).send({}).expect(409);
    expect(res.body.error.code).toBe("review_running");
    expect(temporal.workflow.start).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on the client's id", async () => {
    const { http, temporal } = await start();
    const id = crypto.randomUUID();
    const first = await http.post(BASE).send({ id }).expect(201);
    const again = await http.post(BASE).send({ id }).expect(201);
    expect(again.body.workOrderId).toBe(id);
    expect(again.body.runId).toBe(first.body.runId);
    expect(temporal.workflow.start).toHaveBeenCalledTimes(1);
  });

  it("refuses a closed pull request", async () => {
    const { http, github } = await start();
    github.answers.PrReviewSnapshot = snapshot({ state: "MERGED" });
    const res = await http.post(BASE).send({}).expect(409);
    expect(res.body.error.code).toBe("pull_request_not_open");
  });

  it("re-reviews from the last reviewed head, and fully on the same head", async () => {
    const { http, github, reviews } = await start();
    const first = await http.post(BASE).send({}).expect(201);
    reviews.finish(first.body.workOrderId);
    const same = await http.post(BASE).send({}).expect(201);
    expect(same.body.pullRequest.sinceOid).toBeNull();
    reviews.finish(same.body.workOrderId);
    github.answers.PrReviewSnapshot = snapshot({ headRefOid: "c".repeat(40) });
    const next = await http.post(BASE).send({}).expect(201);
    expect(next.body.pullRequest.sinceOid).toBe(HEAD);
  });

  it("says the latest review is stale when the head moved", async () => {
    const { http } = await start();
    await http.post(BASE).send({}).expect(201);
    expect((await http.get(`${BASE}?head=${HEAD}`).expect(200)).body.review.stale).toBe(false);
    expect((await http.get(`${BASE}?head=${"d".repeat(40)}`).expect(200)).body.review.stale).toBe(
      true,
    );
  });

  it("marks the review failed when Temporal refuses the workflow", async () => {
    const { http, reviews } = await start({ temporalFails: true });
    await http.post(BASE).send({}).expect(500);
    const [row] = [...reviews.rows.values()];
    expect(row?.runStatus).toBe("failed");
    expect(reviews.markFailed).toHaveBeenCalled();
  });
});
