import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ProjectRemote } from "@yugotool/contracts";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { ProjectsService } from "../src/modules/projects/projects.service";
import { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import { PullRequestReviewsService } from "../src/modules/pull-requests/pull-request-reviews.service";
import { PullRequestWritesService } from "../src/modules/pull-requests/pull-request-writes.service";
import { GhMissingError, GithubError } from "../src/modules/pull-requests/pull-requests.errors";
import { PullRequestsController } from "../src/modules/pull-requests/pull-requests.controller";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";
import { FakeGithub } from "./pull-requests-fake-github";

const PROJECT = "85156849-2497-47fa-a2bd-494c776f572b";
const BASE = `/projects/${PROJECT}/pull-requests`;
const GITHUB: ProjectRemote = {
  origin: "git@github.com:acme/app.git",
  github: true,
  ghLoggedIn: true,
  prPossible: true,
  reason: null,
};

let app: INestApplication | undefined;

async function start(remote: () => Promise<ProjectRemote> = () => Promise.resolve(GITHUB)) {
  const github = new FakeGithub();
  const module = await Test.createTestingModule({
    controllers: [PullRequestsController],
    providers: [
      PullRequestsService,
      PullRequestWritesService,
      // YugoTool reviews have their own e2e (pull-request-reviews.e2e.test.ts).
      { provide: PullRequestReviewsService, useValue: {} },
      { provide: GithubClient, useValue: github },
      { provide: ProjectsService, useValue: { remote: vi.fn(remote) } },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { github, http: request(app.getHttpServer()) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("pull requests API", () => {
  it("lists my pull requests", async () => {
    const { http } = await start();
    const res = await http.get(`${BASE}?scope=mine`).expect(200);
    expect(res.body).toMatchObject({ repo: "acme/app", viewer: "me" });
    expect(res.body.items).toHaveLength(5);
  });

  it("lists assigned pull requests, with team requests on request", async () => {
    const { http } = await start();
    expect((await http.get(`${BASE}?scope=assigned`).expect(200)).body.items).toHaveLength(11);
    expect(
      (await http.get(`${BASE}?scope=assigned&teams=true`).expect(200)).body.items,
    ).toHaveLength(15);
  });

  it("rejects an unknown scope", async () => {
    const { http } = await start();
    await http.get(`${BASE}?scope=everything`).expect(400);
  });

  it("returns a pull request's detail", async () => {
    const { http } = await start();
    const res = await http.get(`${BASE}/29302`).expect(200);
    expect(res.body).toMatchObject({ number: 29302, mergeMethods: ["merge", "squash"] });
    expect(res.body.reviewThreads).toHaveLength(6);
  });

  it("is 422 pull_requests_unavailable when the project isn't on GitHub", async () => {
    const { http } = await start(() =>
      Promise.resolve({ ...GITHUB, prPossible: false, reason: "origin is not on GitHub." }),
    );
    const res = await http.get(`${BASE}?scope=mine`).expect(422);
    expect(res.body.error).toMatchObject({
      code: "pull_requests_unavailable",
      message: "origin is not on GitHub.",
    });
  });

  it("is 422 when gh is missing", async () => {
    const { http, github } = await start();
    github.answers.Viewer = new GhMissingError();
    const res = await http.get(`${BASE}?scope=mine`).expect(422);
    expect(res.body.error.code).toBe("pull_requests_unavailable");
  });

  it("posts a comment and busts the cached lists", async () => {
    const { http, github } = await start();
    await http.get(`${BASE}?scope=mine`).expect(200);
    await http.post(`${BASE}/1177/comments`).send({ body: "Looks good" }).expect(204);
    expect(github.calls.find((c) => c.operation === "AddComment")?.variables).toEqual({
      subjectId: "PR_1",
      body: "Looks good",
    });
    const before = github.count("SearchFingerprints");
    await http.get(`${BASE}?scope=mine`).expect(200);
    expect(github.count("SearchFingerprints")).toBe(before + 2);
  });

  it("validates write bodies", async () => {
    const { http } = await start();
    await http.post(`${BASE}/1177/comments`).send({ body: "  " }).expect(400);
  });

  it("puts a line comment into a new pending review", async () => {
    const { http, github } = await start();
    await http
      .post(`${BASE}/1177/review/comments`)
      .send({ path: "src/a.ts", line: 12, side: "RIGHT", body: "Why?" })
      .expect(204);
    const ops = github.operations();
    expect(ops.indexOf("AddReview")).toBeLessThan(ops.indexOf("AddReviewThread"));
    expect(github.calls.find((c) => c.operation === "AddReviewThread")?.variables).toMatchObject({
      reviewId: "PRR_new",
      path: "src/a.ts",
      line: 12,
      startLine: null,
    });
  });

  it("submits the pending review when there is one", async () => {
    const { http, github } = await start();
    github.answers.PrWriteTarget = {
      repository: {
        pullRequest: {
          id: "PR_1",
          pendingReviews: { nodes: [{ id: "PRR_pending", comments: { totalCount: 2 } }] },
        },
      },
    };
    await http.post(`${BASE}/1177/review`).send({ event: "COMMENT", body: "" }).expect(204);
    expect(github.calls.find((c) => c.operation === "SubmitReview")?.variables).toEqual({
      reviewId: "PRR_pending",
      event: "COMMENT",
      body: "",
    });
  });

  it("asks for a body on request changes without pending comments", async () => {
    const { http } = await start();
    const res = await http
      .post(`${BASE}/1177/review`)
      .send({ event: "REQUEST_CHANGES", body: "" })
      .expect(422);
    expect(res.body.error.code).toBe("review_body_required");
  });

  it("turns GitHub's refusal into 422, and a merge refusal into 409", async () => {
    const { http, github } = await start();
    github.answers.AddReview = new GithubError(
      "Can not approve your own pull request",
      null,
      "UNPROCESSABLE",
    );
    const refused = await http
      .post(`${BASE}/1177/review`)
      .send({ event: "APPROVE", body: "" })
      .expect(422);
    expect(refused.body.error).toMatchObject({
      code: "github_refused",
      message: "Can not approve your own pull request",
    });
    github.answers.MergePr = new GithubError(
      "Pull request is not mergeable",
      null,
      "UNPROCESSABLE",
    );
    const merge = await http.post(`${BASE}/1177/merge`).send({ method: "squash" }).expect(409);
    expect(merge.body.error.code).toBe("merge_refused");
  });

  it("merges with the chosen method", async () => {
    const { http, github } = await start();
    await http.post(`${BASE}/1177/merge`).send({ method: "squash" }).expect(204);
    expect(github.calls.find((c) => c.operation === "MergePr")?.variables).toEqual({
      pullRequestId: "PR_1",
      method: "SQUASH",
    });
  });

  it("toggles viewed, resolves threads, marks ready and discards nothing when nothing is pending", async () => {
    const { http, github } = await start();
    await http
      .put(`${BASE}/1177/files/viewed`)
      .send({ path: "src/a.ts", viewed: true })
      .expect(204);
    await http
      .put(`${BASE}/1177/files/viewed`)
      .send({ path: "src/a.ts", viewed: false })
      .expect(204);
    await http.post(`${BASE}/1177/threads/T_1/resolve`).expect(204);
    await http.post(`${BASE}/1177/threads/T_1/unresolve`).expect(204);
    await http.post(`${BASE}/1177/threads/T_1/replies`).send({ body: "Done" }).expect(204);
    await http.post(`${BASE}/1177/ready`).expect(204);
    await http.delete(`${BASE}/1177/review`).expect(204);
    expect(github.operations().filter((o) => o !== "PrWriteTarget" && o !== "Viewer")).toEqual([
      "MarkFileViewed",
      "UnmarkFileViewed",
      "ResolveThread",
      "UnresolveThread",
      "AddThreadReply",
      "MarkReady",
    ]);
  });

  it("is 429 github_rate_limited when GitHub's budget is used up", async () => {
    const { http, github } = await start();
    github.answers.SearchFingerprints = new GithubError(
      "API rate limit already exceeded for user ID 1.",
      null,
      "RATE_LIMITED",
    );
    const res = await http.get(`${BASE}?scope=mine`).expect(429);
    expect(res.body.error.code).toBe("github_rate_limited");
  });

  it("is 404 for an unknown pull request", async () => {
    const { http, github } = await start();
    github.answers.PrWriteTarget = { repository: { pullRequest: null } };
    const res = await http.post(`${BASE}/9/ready`).expect(404);
    expect(res.body.error.code).toBe("pull_request_not_found");
  });
});
