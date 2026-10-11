import type { ProjectRemote } from "@yugotool/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectsService } from "../src/modules/projects/projects.service";
import type { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import {
  GithubError,
  GithubRateLimitedError,
  PullRequestsUnavailableError,
} from "../src/modules/pull-requests/pull-requests.errors";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";
import { FakeGithub } from "./pull-requests-fake-github";

const github = {
  origin: "git@github.com:acme/app.git",
  github: true,
  ghLoggedIn: true,
  prPossible: true,
  reason: null,
} satisfies ProjectRemote;

function setup(remote: ProjectRemote = github) {
  const fake = new FakeGithub();
  const remoteFn = vi.fn(() => Promise.resolve(remote));
  const service = new PullRequestsService(
    fake as unknown as GithubClient,
    { remote: remoteFn } as unknown as ProjectsService,
  );
  return { service, fake };
}

describe("PullRequestsService.list", () => {
  it("returns my PRs newest first with the repo and viewer", async () => {
    const { service, fake } = setup();
    const list = await service.list("p1", "mine", false);
    expect(list.repo).toBe("acme/app");
    expect(list.viewer).toBe("me");
    expect(list.items).toHaveLength(5);
    const updated = list.items.map((i) => i.updatedAt);
    expect(updated).toEqual(updated.toSorted().toReversed());
    const queries = fake.calls
      .filter((c) => c.operation === "SearchFingerprints")
      .map((c) => c.variables.query);
    expect(queries).toEqual([
      expect.stringMatching(/^repo:acme\/app is:pr .*is:open author:@me$/),
      expect.stringMatching(/is:closed author:@me closed:>=\d{4}-\d{2}-\d{2}$/),
    ]);
  });

  it("dedupes assigned PRs across searches and flags team requests", async () => {
    const { service } = setup();
    const without = await service.list("p1", "assigned", false);
    expect(without.items).toHaveLength(11);
    expect(without.items.some((i) => i.requestedFromMyTeam)).toBe(false);
    const withTeams = await service.list("p1", "assigned", true);
    expect(withTeams.items).toHaveLength(15);
    expect(new Set(withTeams.items.map((i) => i.number)).size).toBe(15);
    expect(withTeams.items.find((i) => i.number === 29770)?.requestedFromMyTeam).toBe(true);
  });

  it("caches a list for 20 s and drops it on bust", async () => {
    const { service, fake } = setup();
    await service.list("p1", "mine", false);
    await service.list("p1", "mine", false);
    expect(fake.count("SearchFingerprints")).toBe(2);
    service.bust("p1");
    await service.list("p1", "mine", false);
    expect(fake.count("SearchFingerprints")).toBe(4);
  });

  it("fetches full fields only for PRs whose fingerprint moved", async () => {
    const { service, fake } = setup();
    await service.list("p1", "mine", false);
    expect(fake.count("PrsById")).toBe(1);
    service.bust("p1");
    await service.list("p1", "mine", false);
    expect(fake.count("PrsById")).toBe(1);
    // The assigned board shares the cache: only its own PRs are fetched.
    await service.list("p1", "assigned", false);
    expect(fake.calls.filter((c) => c.operation === "PrsById").at(-1)?.variables.ids).toHaveLength(
      11,
    );
  });

  it("serves the last good list when GitHub refuses, and 429 without one", async () => {
    const { service, fake } = setup();
    const first = await service.list("p1", "mine", false);
    service.bust("p1");
    fake.answers.SearchFingerprints = new GithubError(
      "API rate limit exceeded",
      null,
      "RATE_LIMITED",
    );
    await expect(service.list("p1", "mine", false)).resolves.toEqual(first);
    await expect(service.list("p1", "assigned", false)).rejects.toBeInstanceOf(
      GithubRateLimitedError,
    );
  });

  it("is unavailable when the project can't use PRs", async () => {
    const { service } = setup({
      ...github,
      prPossible: false,
      reason: "The GitHub CLI isn't logged in.",
    });
    await expect(service.list("p1", "mine", false)).rejects.toBeInstanceOf(
      PullRequestsUnavailableError,
    );
  });
});
