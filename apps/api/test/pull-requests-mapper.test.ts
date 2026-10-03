import { describe, expect, it } from "vitest";
import {
  type GhPullRequest,
  ghNodesSchema,
  pullRequestNodes,
  toSummary,
} from "../src/modules/pull-requests/pull-requests.mapper";
import assignedFixture from "./__fixtures__/pull-requests/search-assigned.json";
import mineFixture from "./__fixtures__/pull-requests/search-mine.json";

const search = (raw: { nodes: unknown[] }) =>
  pullRequestNodes(ghNodesSchema.parse({ nodes: raw.nodes }));
const mine = { open: search(mineFixture.data.open), done: search(mineFixture.data.done) };
const assigned = Object.fromEntries(
  Object.entries(assignedFixture.data).map(([key, value]) => [key, search(value)]),
);
const byNumber = (list: GhPullRequest[], n: number): GhPullRequest => {
  const pr = list.find((p) => p.number === n);
  if (!pr) throw new Error(`fixture #${n} missing`);
  return pr;
};
const viewer = "me";
const thread = (resolved: boolean, first: string, last: string) => ({
  isResolved: resolved,
  firstComment: { nodes: [{ author: { login: first } }] },
  lastComment: { nodes: [{ author: { login: last } }] },
});

describe("toSummary", () => {
  it("maps state, CI and conflicts on my open PR", () => {
    const summary = toSummary(byNumber(mine.open, 1177), { viewer });
    expect(summary).toMatchObject({
      number: 1177,
      state: "open",
      isDraft: false,
      author: { login: "me" },
      mergeable: "CONFLICTING",
      ci: "failure",
      reviewers: [],
      myLastReview: null,
      threads: { unresolved: 0, waitingOnMe: 0 },
    });
    expect(summary.failingChecks.length).toBeGreaterThan(0);
    expect(summary.failingChecks.length).toBeLessThanOrEqual(5);
  });

  it("maps closed PRs", () => {
    expect(toSummary(byNumber(mine.done, 1175), { viewer }).state).toBe("closed");
    expect(toSummary(byNumber(assigned.reviewedDone ?? [], 29744), { viewer })).toMatchObject({
      state: "merged",
      mergeable: "UNKNOWN",
    });
  });

  it("lists requested users and teams, and flags a request from me", () => {
    const summary = toSummary(byNumber(assigned.requested ?? [], 29716), { viewer });
    expect(summary.requestedFromMe).toBe(true);
    expect(summary.requestedFromMyTeam).toBe(false);
    expect(summary.reviewers).toEqual([
      { team: "team-a", state: "REQUESTED" },
      { actor: { login: "me", avatarUrl: "https://avatars.example/me" }, state: "REQUESTED" },
    ]);
  });

  it("reads my last review and the other reviewers' states", () => {
    const summary = toSummary(byNumber(assigned.reviewed ?? [], 29281), { viewer });
    expect(summary.myLastReview).toMatchObject({ state: "APPROVED" });
    expect(summary.myLastReview?.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(
      summary.reviewers.map((r) => ("actor" in r ? `${r.actor.login}:${r.state}` : r.team)),
    ).toEqual(["mila:COMMENTED", "me:APPROVED"]);
  });

  it("flags assignment and team requests", () => {
    expect(toSummary(byNumber(assigned.assigned ?? [], 27138), { viewer }).assignedToMe).toBe(true);
    expect(
      toSummary(byNumber(assigned.team ?? [], 29770), { viewer, teamRequested: true })
        .requestedFromMyTeam,
    ).toBe(true);
  });

  it("counts threads waiting on me: last comment not mine, on my PR or a thread I started", () => {
    const base = byNumber(mine.open, 1176);
    const threads = [
      thread(false, "ana", "ana"),
      thread(false, "ana", "me"),
      thread(true, "ana", "ana"),
      thread(false, "me", "marko"),
    ];
    expect(toSummary({ ...base, reviewThreads: { nodes: threads } }, { viewer }).threads).toEqual({
      unresolved: 3,
      waitingOnMe: 2,
    });
    const theirs = {
      ...base,
      author: { login: "ana", avatarUrl: "" },
      reviewThreads: { nodes: threads },
    };
    expect(toSummary(theirs, { viewer }).threads).toEqual({ unresolved: 3, waitingOnMe: 1 });
  });
});

describe("pullRequestNodes", () => {
  it("drops nodes that aren't pull requests", () => {
    expect(search({ nodes: [{}, null] })).toEqual([]);
  });
});
