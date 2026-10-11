import type { PullRequestList, PullRequestSummary } from "@yugotool/contracts";
import { enqueueNotification, hasNotificationJobs } from "@yugotool/notify";
import { describe, expect, it, vi } from "vitest";
import { reviewRequestJobs } from "../src/modules/pull-requests/review-requests";
import { ReviewRequestsWatcher } from "../src/modules/pull-requests/review-requests.watcher";

const PROJECT = "85156849-2497-47fa-a2bd-494c776f572b";

vi.mock("@yugotool/notify", () => ({
  enqueueNotification: vi.fn(() => Promise.resolve()),
  hasNotificationJobs: vi.fn(() => Promise.resolve(true)),
}));
const notify = { enqueueNotification, hasNotificationJobs };

const pr = (number: number, overrides: Partial<PullRequestSummary> = {}) =>
  ({
    number,
    title: `PR ${number}`,
    state: "open",
    author: { login: "ana", avatarUrl: "" },
    requestedFromMe: true,
    myLastReview: null,
    ...overrides,
  }) as PullRequestSummary;

const list = (items: PullRequestSummary[]): PullRequestList => ({
  repo: "acme/app",
  viewer: "me",
  items,
  fetchedAt: "2026-10-04T10:00:00.000Z",
});

describe("reviewRequestJobs", () => {
  it("keeps open PRs that ask me, keyed by my last review", () => {
    const jobs = reviewRequestJobs(
      PROJECT,
      list([
        pr(1),
        pr(2, { requestedFromMe: false }),
        pr(3, { state: "merged" }),
        pr(4, {
          myLastReview: {
            state: "COMMENTED",
            commitOid: "abc",
            submittedAt: "2026-10-03T09:00:00.000Z",
          },
        }),
      ]),
    );
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      `pr_review_requested:${PROJECT}:1:first`,
      `pr_review_requested:${PROJECT}:4:2026-10-03T09:00:00.000Z`,
    ]);
    expect(jobs[0]?.job.payload).toEqual({
      projectId: PROJECT,
      number: 1,
      title: "PR 1",
      author: "ana",
      repo: "acme/app",
    });
  });
});

function watcher(prPossible = true) {
  const projects = {
    list: vi.fn(() => Promise.resolve([{ id: PROJECT, name: "acme" }])),
    remote: vi.fn(() => Promise.resolve({ prPossible })),
  };
  const pullRequests = { list: vi.fn(() => Promise.resolve(list([pr(1), pr(2)]))) };
  return new ReviewRequestsWatcher({ db: {} } as never, projects as never, pullRequests as never);
}

describe("ReviewRequestsWatcher", () => {
  it("records a baseline on a project's first look", async () => {
    vi.mocked(notify.hasNotificationJobs).mockResolvedValueOnce(false);
    vi.mocked(notify.enqueueNotification).mockClear();
    expect(await watcher().pollProject(PROJECT)).toBe(0);
    const calls = vi.mocked(notify.enqueueNotification).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c[3]?.silent === true)).toBe(true);
    expect(calls.at(-1)?.[2]).toBe(`pr_review_requested:${PROJECT}:baseline`);
  });

  it("queues requests once the project has been seen", async () => {
    vi.mocked(notify.enqueueNotification).mockClear();
    expect(await watcher().pollProject(PROJECT)).toBe(2);
    const calls = vi.mocked(notify.enqueueNotification).mock.calls;
    expect(calls.map((c) => c[3]?.silent)).toEqual([false, false]);
  });

  it("skips projects without a GitHub remote", async () => {
    vi.mocked(notify.enqueueNotification).mockClear();
    expect(await watcher(false).pollProject(PROJECT)).toBe(0);
    expect(notify.enqueueNotification).not.toHaveBeenCalled();
  });
});
