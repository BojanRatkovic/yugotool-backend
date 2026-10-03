import { describe, expect, it, vi } from "vitest";
import type { ProjectsService } from "../src/modules/projects/projects.service";
import type { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import { capPatch, onlyPrFiles } from "../src/modules/pull-requests/pull-requests.diff";
import {
  GithubError,
  PullRequestNotFoundError,
  SinceUnknownError,
} from "../src/modules/pull-requests/pull-requests.errors";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

const remote = () =>
  Promise.resolve({
    origin: "https://github.com/acme/app",
    github: true,
    ghLoggedIn: true,
    prPossible: true,
    reason: null,
  });

function setup(text: (path: string) => Promise<string>, refs?: () => Promise<unknown>) {
  const rest = vi.fn((_path: string, schema: { parse(v: unknown): unknown }) =>
    (refs ?? (() => Promise.resolve({ head: { sha: HEAD }, base: { sha: BASE } })))().then((v) =>
      schema.parse(v),
    ),
  );
  const restText = vi.fn((path: string) => text(path));
  const service = new PullRequestsService(
    { rest, restText } as unknown as GithubClient,
    { remote } as unknown as ProjectsService,
  );
  return { service, rest, restText };
}

describe("capPatch", () => {
  it("keeps a small patch whole", () => {
    expect(capPatch(PATCH)).toEqual({ patch: PATCH, truncated: false });
  });

  it("keeps only the files the PR changes", () => {
    const other = "diff --git a/y b/y\n@@ -1 +1 @@\n-a\n+b\n";
    expect(onlyPrFiles(other + PATCH, PATCH)).toBe(PATCH);
    expect(onlyPrFiles(other, PATCH)).toBe("");
  });

  it("cuts at the last whole line under the cap", () => {
    expect(capPatch("one\ntwo\nthree\n", 10)).toEqual({ patch: "one\ntwo\n", truncated: true });
  });
});

describe("PullRequestsService.diff", () => {
  it("returns the full PR diff between base and head", async () => {
    const { service, restText } = setup(() => Promise.resolve(PATCH));
    await expect(service.diff("p1", 7)).resolves.toEqual({
      patch: PATCH,
      truncated: false,
      base: BASE,
      head: HEAD,
    });
    expect(restText).toHaveBeenCalledWith("repos/acme/app/pulls/7", {
      accept: "application/vnd.github.diff",
    });
  });

  it("compares from `since` to the head, without files merged in from the base", async () => {
    const since = "c".repeat(40);
    const fromBase = "diff --git a/base.ts b/base.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const { service, restText } = setup((path) =>
      Promise.resolve(path.includes("/compare/") ? PATCH + fromBase : PATCH),
    );
    await expect(service.diff("p1", 7, since)).resolves.toEqual({
      patch: PATCH,
      truncated: false,
      base: since,
      head: HEAD,
    });
    expect(restText.mock.calls.map(([p]) => p)).toContain(
      `repos/acme/app/compare/${since}...${HEAD}`,
    );
  });

  it("is since_unknown when GitHub no longer has the commit", async () => {
    const { service } = setup((path) =>
      path.includes("/compare/")
        ? Promise.reject(new GithubError("Not Found", 404))
        : Promise.resolve(PATCH),
    );
    await expect(service.diff("p1", 7, "c".repeat(40))).rejects.toBeInstanceOf(SinceUnknownError);
  });

  it("returns an empty truncated patch when GitHub refuses a huge diff", async () => {
    const { service } = setup(() => Promise.reject(new GithubError("diff too large", 406)));
    await expect(service.diff("p1", 7)).resolves.toMatchObject({ patch: "", truncated: true });
  });

  it("is 404 for an unknown PR", async () => {
    const { service } = setup(
      () => Promise.resolve(PATCH),
      () => Promise.reject(new GithubError("Not Found", 404)),
    );
    await expect(service.diff("p1", 7)).rejects.toBeInstanceOf(PullRequestNotFoundError);
  });
});
