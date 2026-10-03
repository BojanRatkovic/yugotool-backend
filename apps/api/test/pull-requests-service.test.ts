import type { ProjectRemote } from "@zastava/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectsService } from "../src/modules/projects/projects.service";
import type { GithubClient } from "../src/modules/pull-requests/github/gh-client";
import { PullRequestsUnavailableError } from "../src/modules/pull-requests/pull-requests.errors";
import { PullRequestsService } from "../src/modules/pull-requests/pull-requests.service";
import assignedFixture from "./__fixtures__/pull-requests/search-assigned.json";
import mineFixture from "./__fixtures__/pull-requests/search-mine.json";

const github = {
  origin: "git@github.com:acme/app.git",
  github: true,
  ghLoggedIn: true,
  prPossible: true,
  reason: null,
} satisfies ProjectRemote;

/** The fixture search a query string asks for. */
function fixtureFor(q: string): unknown {
  const { data: mine } = mineFixture;
  const { data: assigned } = assignedFixture;
  if (q.includes("author:@me") && !q.includes("-author:@me")) {
    return q.includes("is:open") ? mine.open : mine.done;
  }
  if (q.includes("user-review-requested:@me")) return assigned.requested;
  if (q.includes("assignee:@me")) return assigned.assigned;
  if (q.includes("reviewed-by:@me"))
    return q.includes("is:closed") ? assigned.reviewedDone : assigned.reviewed;
  if (q.includes("review-requested:@me")) return assigned.team;
  throw new Error(`unexpected search ${q}`);
}

function setup(remote: ProjectRemote = github) {
  const graphql = vi.fn(
    (query: string, variables: Record<string, unknown>, schema: { parse(v: unknown): unknown }) =>
      Promise.resolve(
        schema.parse(
          query.includes("query Viewer")
            ? { viewer: { login: "me" } }
            : { search: fixtureFor(String(variables.query)) },
        ),
      ),
  );
  const remoteFn = vi.fn(() => Promise.resolve(remote));
  const service = new PullRequestsService(
    { graphql } as unknown as GithubClient,
    { remote: remoteFn } as unknown as ProjectsService,
  );
  return { service, graphql, remoteFn };
}

describe("PullRequestsService.list", () => {
  it("returns my PRs newest first with the repo and viewer", async () => {
    const { service, graphql } = setup();
    const list = await service.list("p1", "mine", false);
    expect(list.repo).toBe("acme/app");
    expect(list.viewer).toBe("me");
    expect(list.items.map((i) => i.number)).toHaveLength(5);
    const updated = list.items.map((i) => i.updatedAt);
    expect(updated).toEqual(updated.toSorted().toReversed());
    const queries = graphql.mock.calls.map(([, v]) => v.query).filter(Boolean);
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
    const { service, graphql } = setup();
    await service.list("p1", "mine", false);
    await service.list("p1", "mine", false);
    const searches = () => graphql.mock.calls.filter(([q]) => q.includes("SearchPrs")).length;
    expect(searches()).toBe(2);
    service.bust("p1");
    await service.list("p1", "mine", false);
    expect(searches()).toBe(4);
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
