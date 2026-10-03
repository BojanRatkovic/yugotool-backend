import detailFixture from "./__fixtures__/pull-requests/detail-detail.json";
import filesFixture from "./__fixtures__/pull-requests/detail-files.json";
import threadsFixture from "./__fixtures__/pull-requests/detail-threads.json";
import timelineFixture from "./__fixtures__/pull-requests/detail-timeline.json";
import assignedFixture from "./__fixtures__/pull-requests/search-assigned.json";
import mineFixture from "./__fixtures__/pull-requests/search-mine.json";

type Schema = { parse(v: unknown): unknown };
type Answer = ((variables: Record<string, unknown>) => unknown) | object | Error;

/** Every PR node in the search fixtures, by node id. */
const allPrs = new Map<string, unknown>();
for (const search of [...Object.values(mineFixture.data), ...Object.values(assignedFixture.data)]) {
  for (const pr of search.nodes as { id: string }[]) allPrs.set(pr.id, pr);
}

/** The fixture search a query string asks for. */
export function searchFixture(q: string): { nodes: unknown[] } {
  const { data: mine } = mineFixture;
  const { data: assigned } = assignedFixture;
  if (q.includes(" author:@me")) return q.includes("is:open") ? mine.open : mine.done;
  if (q.includes("user-review-requested:@me")) return assigned.requested;
  if (q.includes("assignee:@me")) return assigned.assigned;
  if (q.includes("reviewed-by:@me")) {
    return q.includes("is:closed") ? assigned.reviewedDone : assigned.reviewed;
  }
  if (q.includes("review-requested:@me")) return assigned.team;
  throw new Error(`unexpected search ${q}`);
}

/** A fake GitHub that answers by GraphQL operation name; an Error answer is thrown. */
export class FakeGithub {
  calls: { operation: string; variables: Record<string, unknown> }[] = [];
  answers: Record<string, Answer> = {
    Viewer: { viewer: { login: "me" } },
    SearchFingerprints: (v) => ({ search: searchFixture(String(v.query)) }),
    PrsById: (v) => ({
      nodes: (Array.isArray(v.ids) ? v.ids : []).map((id) => allPrs.get(String(id)) ?? null),
    }),
    PrFingerprint: { repository: { pullRequest: { updatedAt: "2026-10-02T10:00:00Z" } } },
    PrDetail: detailFixture.data,
    PrThreads: threadsFixture.data,
    PrFiles: filesFixture.data,
    PrTimeline: timelineFixture.data,
    PrWriteTarget: {
      repository: { pullRequest: { id: "PR_1", pendingReviews: { nodes: [] } } },
    },
    AddReview: { addPullRequestReview: { pullRequestReview: { id: "PRR_new" } } },
    AddReviewThread: (v) => ({
      addPullRequestReviewThread: { thread: { id: `PRRT_${String(v.path)}:${String(v.line)}` } },
    }),
  };

  graphql(query: string, variables: Record<string, unknown>, schema: Schema): Promise<unknown> {
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?";
    this.calls.push({ operation, variables });
    const answer = this.answers[operation] ?? {};
    const value = typeof answer === "function" ? answer(variables) : answer;
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value));
  }

  count(operation: string): number {
    return this.calls.filter((c) => c.operation === operation).length;
  }

  operations(): string[] {
    return this.calls.map((c) => c.operation);
  }
}
