import type { NotificationJob, PullRequestList } from "@zastava/contracts";

export interface ReviewRequestJob {
  job: Extract<NotificationJob, { kind: "pr_review_requested" }>;
  dedupeKey: string;
}

/** Every job key of a project starts with this, so "seen before?" is a prefix check. */
export const reviewRequestPrefix = (projectId: string) => `pr_review_requested:${projectId}:`;

/**
 * Open PRs that ask for my review, as notification jobs. The key includes my
 * last review, so a re-request after I reviewed is news again; the same open
 * request polled twice is not.
 */
export function reviewRequestJobs(projectId: string, list: PullRequestList): ReviewRequestJob[] {
  return list.items
    .filter((pr) => pr.state === "open" && pr.requestedFromMe)
    .map((pr) => ({
      job: {
        kind: "pr_review_requested",
        payload: {
          projectId,
          number: pr.number,
          title: pr.title,
          author: pr.author.login,
          repo: list.repo,
        },
      },
      dedupeKey: `${reviewRequestPrefix(projectId)}${pr.number}:${pr.myLastReview?.submittedAt ?? "first"}`,
    }));
}
