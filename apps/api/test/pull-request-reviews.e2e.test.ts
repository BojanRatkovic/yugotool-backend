import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type {
  ProjectRemote,
  ReviewFinding,
  ReviewPullRequest,
  ReviewVerdict,
} from "@zastava/contracts";
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
import { GithubError } from "../src/modules/pull-requests/pull-requests.errors";
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
            id: "PRRT_ana",
            isResolved: false,
            path: "src/a.ts",
            line: 3,
            comments: { nodes: [{ body: "Why not a map?", author: { login: "ana" } }] },
          },
          {
            id: "PRRT_done",
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
  lastDoneReview = vi.fn(async (_db: unknown, projectId: string, number: number) => {
    const row = this.forPr(projectId, number).findLast((r) => r.status === "done");
    return row ? { pullRequest: row.pullRequest, findings: row.verdict?.findings ?? [] } : null;
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
  briefs = vi.fn(async (_db: unknown, projectId: string) =>
    [...this.rows.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        number: r.pullRequest.number,
        status: r.runStatus ?? "running",
        headOid: r.pullRequest.headOid,
        findings: r.verdict ? r.verdict.findings.length : null,
        posted: r.pullRequest.posted.length,
      })),
  );
  markPosted = vi.fn(
    async (
      _db: unknown,
      workOrderId: string,
      ids: string[],
      threads: Record<string, string> = {},
    ) => {
      const row = this.rows.get(workOrderId);
      if (!row) return;
      const posted = [...new Set([...row.pullRequest.posted, ...ids])];
      const postedThreads = { ...row.pullRequest.postedThreads, ...threads };
      this.rows.set(workOrderId, {
        ...row,
        pullRequest: { ...row.pullRequest, posted, postedThreads },
      });
    },
  );
  markFailed = vi.fn(async (_db: unknown, workOrderId: string) => {
    const row = this.rows.get(workOrderId);
    if (row) this.rows.set(workOrderId, { ...row, status: "failed", runStatus: "failed" });
  });

  finish(workOrderId: string, verdict: ReviewVerdict | null = null) {
    const row = this.rows.get(workOrderId);
    if (row)
      this.rows.set(workOrderId, { ...row, status: "done", runStatus: "succeeded", verdict });
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
        postedThreads: {},
        previousFindings: [],
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

const finding = (patch: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1",
  severity: "critical",
  category: "bug",
  file: "src/a.ts",
  side: "RIGHT",
  startLine: null,
  line: 12,
  title: "Null deref",
  body: "items[0] is undefined when empty.",
  suggestion: null,
  confidence: "high",
  ...patch,
});
const VERDICT: ReviewVerdict = {
  recommendation: "request_changes",
  summary: "Adds paging.",
  findings: [
    finding({}),
    finding({ id: "f2", severity: "minor", file: null, line: null, title: "No tests" }),
  ],
  previous: [],
};
const target = (pending: { id: string; body: string } | null, head = HEAD) => ({
  repository: {
    pullRequest: {
      id: "PR_1",
      headRefOid: head,
      pendingReviews: {
        nodes: pending ? [{ ...pending, comments: { totalCount: 0 } }] : [],
      },
    },
  },
});
const POST = `${BASE}/post`;
const edits = [
  {
    id: "f1",
    title: "Null deref",
    body: "Guard the empty list.",
    suggestion: "if (!items[0]) return;",
  },
  { id: "f2", title: "No tests", body: "Add a paging test.", suggestion: null },
];

async function finished() {
  const ctx = await start();
  const res = await ctx.http.post(BASE).send({}).expect(201);
  ctx.reviews.finish(res.body.workOrderId, VERDICT);
  return { ...ctx, workOrderId: res.body.workOrderId as string };
}

describe("posting findings", () => {
  it("is 409 review_not_ready before a review finished", async () => {
    const { http } = await start();
    await http.post(BASE).send({}).expect(201);
    const res = await http
      .post(POST)
      .send({ findings: [edits[0]] })
      .expect(409);
    expect(res.body.error.code).toBe("review_not_ready");
  });

  it("adds line findings as comments and the rest to a new pending review's summary", async () => {
    const { http, github } = await finished();
    github.answers.PrWriteTarget = target(null);
    const res = await http.post(POST).send({ findings: edits }).expect(200);
    expect(res.body.pullRequest.posted.toSorted()).toEqual(["f1", "f2"]);
    // The line finding's thread is remembered; the summary finding has none.
    expect(res.body.pullRequest.postedThreads).toEqual({ f1: "PRRT_src/a.ts:12" });
    expect(github.operations().filter((o) => o.startsWith("Add"))).toEqual([
      "AddReview",
      "AddReviewThread",
    ]);
    const review = github.calls.find((c) => c.operation === "AddReview");
    expect(review?.variables).toMatchObject({ pullRequestId: "PR_1" });
    expect(review?.variables).not.toHaveProperty("event");
    expect(String(review?.variables.body)).toContain("**No tests**");
    const thread = github.calls.find((c) => c.operation === "AddReviewThread");
    expect(thread?.variables).toMatchObject({ reviewId: "PRR_new", path: "src/a.ts", line: 12 });
    expect(String(thread?.variables.body)).toBe(
      "**Null deref**\n\nGuard the empty list.\n\n```suggestion\nif (!items[0]) return;\n```",
    );
    expect(github.count("SubmitReview")).toBe(0);
  });

  it("appends to an existing pending review's summary", async () => {
    const { http, github } = await finished();
    github.answers.PrWriteTarget = target({ id: "PRR_mine", body: "My notes." });
    await http
      .post(POST)
      .send({ findings: [edits[1]] })
      .expect(200);
    const update = github.calls.find((c) => c.operation === "UpdateReviewBody");
    expect(update?.variables.reviewId).toBe("PRR_mine");
    expect(String(update?.variables.body)).toMatch(/^My notes\.\n\n\*\*No tests\*\*/);
    expect(github.count("AddReview")).toBe(0);
  });

  it("is 422 review_stale when the PR moved, and writes nothing", async () => {
    const { http, github, reviews } = await finished();
    github.answers.PrWriteTarget = target(null, "e".repeat(40));
    const res = await http.post(POST).send({ findings: edits }).expect(422);
    expect(res.body.error.code).toBe("review_stale");
    expect(github.operations().some((o) => o.startsWith("Add"))).toBe(false);
    expect(reviews.markPosted).not.toHaveBeenCalled();
  });

  it("remembers what got in when GitHub refuses a comment", async () => {
    const { http, github, workOrderId, reviews } = await finished();
    github.answers.PrWriteTarget = target(null);
    github.answers.AddReviewThread = new GithubError(
      "Line could not be resolved",
      null,
      "UNPROCESSABLE",
    );
    const res = await http.post(POST).send({ findings: edits }).expect(422);
    expect(res.body.error.code).toBe("github_refused");
    expect(res.body.error.message).toContain("1 of 2 added");
    expect(reviews.rows.get(workOrderId)?.pullRequest.posted).toEqual(["f2"]);
    expect(reviews.rows.get(workOrderId)?.pullRequest.postedThreads).toEqual({});
  });

  it("is 422 finding_unknown for ids the review doesn't have", async () => {
    const { http } = await finished();
    const res = await http
      .post(POST)
      .send({ findings: [{ id: "f9", title: "x", body: "", suggestion: null }] })
      .expect(422);
    expect(res.body.error.code).toBe("finding_unknown");
  });
});

describe("review briefs", () => {
  it("lists each PR's latest review for the cards (not routed as a PR number)", async () => {
    const { http, reviews } = await start();
    const res = await http.post(BASE).send({}).expect(201);
    reviews.finish(res.body.workOrderId, VERDICT);
    const list = await http.get(`/projects/${PROJECT}/pull-requests/zastava-reviews`).expect(200);
    expect(list.body).toEqual({
      items: [{ number: 42, status: "succeeded", headOid: HEAD, findings: 2, posted: 0 }],
    });
  });
});

describe("re-review (spec 0010)", () => {
  it("freezes the last done review's findings with their threads' state", async () => {
    const { http, github } = await finished();
    github.answers.PrWriteTarget = target(null);
    await http.post(POST).send({ findings: edits }).expect(200);
    const next = "c".repeat(40);
    const mine = {
      id: "PRRT_src/a.ts:12",
      isResolved: true,
      path: "src/a.ts",
      line: 14,
      comments: { nodes: [{ body: "**Null deref**", author: { login: "me" } }] },
    };
    const base = snapshot().repository.pullRequest.reviewThreads.nodes;
    github.answers.PrReviewSnapshot = snapshot({
      headRefOid: next,
      reviewThreads: { nodes: [...base, { ...mine, isResolved: false }] },
    });
    const res = await http.post(BASE).send({}).expect(201);
    expect(res.body.pullRequest.sinceOid).toBe(HEAD);
    expect(res.body.pullRequest.previousFindings).toEqual([
      {
        id: "f1",
        severity: "critical",
        category: "bug",
        file: "src/a.ts",
        line: 12,
        title: "Null deref",
        body: "items[0] is undefined when empty.",
        posted: true,
        threadId: "PRRT_src/a.ts:12",
        threadResolved: false,
      },
      expect.objectContaining({ id: "f2", posted: true, threadId: null, threadResolved: null }),
    ]);
    // My own thread is checked as a previous finding, not passed as "do not repeat".
    expect(res.body.pullRequest.openThreads).toEqual([
      { path: "src/a.ts", line: 3, author: "ana", body: "Why not a map?" },
    ]);
  });

  it("has no previous findings on a first review", async () => {
    const { http } = await start();
    const res = await http.post(BASE).send({}).expect(201);
    expect(res.body.pullRequest.previousFindings).toEqual([]);
  });
});
