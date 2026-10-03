import { describe, expect, it, vi } from "vitest";
import type { ProjectsService } from "../src/modules/projects/projects.service";
import type { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import {
  GithubError,
  PullRequestNotFoundError,
} from "../src/modules/pull-requests/pull-requests.errors";
import { toTimeline } from "../src/modules/pull-requests/pull-requests.mapper";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";
import detailFixture from "./__fixtures__/pull-requests/detail-detail.json";
import filesFixture from "./__fixtures__/pull-requests/detail-files.json";
import threadsFixture from "./__fixtures__/pull-requests/detail-threads.json";
import timelineFixture from "./__fixtures__/pull-requests/detail-timeline.json";

type Schema = { parse(v: unknown): unknown };

const remote = () =>
  Promise.resolve({
    origin: "git@github.com:acme/app.git",
    github: true,
    ghLoggedIn: true,
    prPossible: true,
    reason: null,
  });

const commit = (oid: string, login: string) => ({
  kind: "PullRequestCommit",
  commit: { oid, committedDate: "2026-10-01T10:00:00Z", author: { user: { login } } },
});

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  const responses: Record<string, unknown> = {
    "query Viewer": { viewer: { login: "me" } },
    "query PrDetail": detailFixture.data,
    "query PrThreads": threadsFixture.data,
    "query PrFiles": filesFixture.data,
    "query PrTimeline": timelineFixture.data,
    ...overrides,
  };
  const graphql = vi.fn((query: string, _vars: unknown, schema: Schema) => {
    const key = Object.keys(responses).find((k) => query.includes(k));
    const value = key ? responses[key] : undefined;
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value));
  });
  const service = new PullRequestsService(
    { graphql } as unknown as GithubClient,
    { remote } as unknown as ProjectsService,
  );
  return { service, graphql };
}

describe("PullRequestsService.detail", () => {
  it("maps the panel's data from the four requests", async () => {
    const { service } = setup();
    const detail = await service.detail("p1", 29302);
    expect(detail).toMatchObject({
      number: 29302,
      state: "open",
      bodyHtml: expect.stringContaining("<p>"),
      viewerCanUpdate: true,
      viewerCanMerge: true,
      mergeMethods: ["merge", "squash"],
      pendingReview: null,
      truncated: { files: false, threads: false, timeline: false, commits: false },
    });
    expect(detail.files).toHaveLength(25);
    expect(detail.files[0]).toMatchObject({ viewed: false, changeType: "MODIFIED" });
    expect(detail.commits).toHaveLength(6);
    expect(detail.commits[0]).toMatchObject({ oid: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("maps threads with their hunk and resolvability, and counts them", async () => {
    const { service } = setup();
    const detail = await service.detail("p1", 29302);
    expect(detail.reviewThreads).toHaveLength(6);
    const [thread] = detail.reviewThreads;
    expect(thread).toMatchObject({
      isResolved: false,
      side: "RIGHT",
      viewerCanResolve: true,
      diffHunk: expect.stringMatching(/^@@ /),
    });
    expect(thread?.comments[0]).toMatchObject({
      isPending: false,
      author: { login: expect.any(String) },
    });
    expect(detail.threads.unresolved).toBe(
      detail.reviewThreads.filter((t) => !t.isResolved).length,
    );
  });

  it("orders checks failing first and reads workflows", async () => {
    const { service } = setup();
    const { checks } = await service.detail("p1", 29302);
    const order = ["fail", "pending", "pass", "skipping", "cancel"];
    const ranks = checks.map((c) => order.indexOf(c.state));
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b));
    expect(checks.some((c) => c.workflow?.startsWith("Workflow"))).toBe(true);
  });

  it("builds the timeline with grouped commits and review thread links", async () => {
    const { service } = setup();
    const { timeline, reviewThreads } = await service.detail("p1", 29302);
    const kinds = timeline.map((i) => i.kind);
    expect(kinds[0]).toBe("force_push");
    expect(kinds).toContain("commits");
    expect(kinds).toContain("review_requested");
    // No two commit groups by the same author in a row.
    timeline.forEach((item, i) => {
      const prev = timeline[i - 1];
      if (item.kind === "commits" && prev?.kind === "commits") {
        expect(prev.author?.login).not.toBe(item.author?.login);
      }
    });
    const review = timeline.find((i) => i.kind === "review" && i.threadIds.length > 0);
    expect(review?.kind === "review" && review.threadIds[0]).toBe(reviewThreads[0]?.id);
  });

  it("is 404 when GitHub doesn't know the PR", async () => {
    const { service } = setup({
      "query PrDetail": new GithubError("Could not resolve to a PullRequest", 404),
    });
    await expect(service.detail("p1", 1)).rejects.toBeInstanceOf(PullRequestNotFoundError);
  });
});

describe("toTimeline", () => {
  it("groups consecutive commits per author and skips pending reviews", () => {
    const items = toTimeline(
      [
        commit("a", "ana"),
        commit("b", "ana"),
        commit("c", "marko"),
        { kind: "PullRequestReview", id: "r", state: "PENDING", createdAt: "2026-10-01T11:00:00Z" },
        commit("d", "marko"),
      ],
      new Map(),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "commits", count: 2, oids: ["a", "b"] }),
      expect.objectContaining({ kind: "commits", count: 2, oids: ["c", "d"] }),
    ]);
  });
});
