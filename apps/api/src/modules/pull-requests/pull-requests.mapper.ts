import type {
  PrActor,
  PrCiState,
  PrReviewer,
  PrReviewState,
  PullRequestSummary,
} from "@zastava/contracts";
import { prReviewStateSchema } from "@zastava/contracts";
import { z } from "zod";

// ── GitHub shapes (what PR_FIELDS returns) ──────────────────────────────────

const ghActorSchema = z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable();

const nodes = <T extends z.ZodType>(item: T) => z.object({ nodes: z.array(item.nullable()) });

const ghRollupSchema = z
  .object({
    state: z.string(),
    contexts: nodes(
      z.object({
        kind: z.string(),
        name: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        context: z.string().optional(),
        state: z.string().optional(),
      }),
    ),
  })
  .nullable();

export const ghPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  author: ghActorSchema,
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  comments: z.object({ totalCount: z.number().int() }),
  labels: nodes(z.object({ name: z.string(), color: z.string() })).nullable(),
  assignees: nodes(z.object({ login: z.string() })),
  reviewRequests: nodes(
    z.object({
      requestedReviewer: z
        .object({
          kind: z.string(),
          login: z.string().optional(),
          avatarUrl: z.string().optional(),
          name: z.string().optional(),
        })
        .nullable(),
    }),
  ).nullable(),
  latestReviews: nodes(z.object({ state: z.string(), author: ghActorSchema })).nullable(),
  myReviews: nodes(
    z.object({
      state: z.string(),
      submittedAt: z.string().nullable(),
      commit: z.object({ oid: z.string() }).nullable(),
    }),
  ).nullable(),
  reviewThreads: nodes(
    z.object({
      isResolved: z.boolean(),
      firstComment: nodes(z.object({ author: ghActorSchema })),
      lastComment: nodes(z.object({ author: ghActorSchema })),
    }),
  ),
  commits: nodes(z.object({ commit: z.object({ statusCheckRollup: ghRollupSchema }) })),
});
export type GhPullRequest = z.infer<typeof ghPullRequestSchema>;

/** A search result; nodes that aren't pull requests come back as `{}` and are dropped. */
export const ghSearchSchema = z.object({
  issueCount: z.number().int(),
  nodes: z.array(z.union([ghPullRequestSchema, z.object({}).strict()]).nullable()),
});
export type GhSearch = z.infer<typeof ghSearchSchema>;

export function searchPullRequests(search: GhSearch | null | undefined): GhPullRequest[] {
  return (search?.nodes ?? []).filter((n): n is GhPullRequest => n !== null && "number" in n);
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const GHOST: PrActor = { login: "ghost", avatarUrl: "" };
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);

const compact = <T>(list: { nodes: (T | null)[] } | null | undefined): T[] =>
  (list?.nodes ?? []).filter((n): n is T => n !== null);

export function toActor(actor: { login: string; avatarUrl?: string | undefined } | null): PrActor {
  return actor ? { login: actor.login, avatarUrl: actor.avatarUrl ?? "" } : GHOST;
}

/** The head commit's check rollup as one state. */
export function ciState(rollupState: string | null | undefined): PrCiState {
  switch (rollupState) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function reviewState(state: string): PrReviewState | null {
  const parsed = prReviewStateSchema.safeParse(state);
  return parsed.success ? parsed.data : null;
}

function reviewers(pr: GhPullRequest): PrReviewer[] {
  const authorLogin = pr.author?.login;
  const list: PrReviewer[] = [];
  const requested = new Set<string>();
  for (const { requestedReviewer: r } of compact(pr.reviewRequests)) {
    if (r?.kind === "Team" && r.name) list.push({ team: r.name, state: "REQUESTED" });
    if (r?.kind === "User" && r.login) {
      requested.add(r.login);
      list.push({ actor: toActor({ login: r.login, avatarUrl: r.avatarUrl }), state: "REQUESTED" });
    }
  }
  for (const review of compact(pr.latestReviews)) {
    const state = reviewState(review.state);
    const login = review.author?.login;
    // A re-requested reviewer shows as requested; the author's own comments aren't reviews.
    if (!state || state === "PENDING" || !login || login === authorLogin || requested.has(login)) {
      continue;
    }
    list.push({ actor: toActor(review.author), state });
  }
  return list;
}

function myLastReview(pr: GhPullRequest): PullRequestSummary["myLastReview"] {
  const submitted = compact(pr.myReviews)
    .flatMap((r) => {
      const state = reviewState(r.state);
      return state && state !== "PENDING" && r.submittedAt
        ? [{ state, commitOid: r.commit?.oid ?? "", submittedAt: r.submittedAt }]
        : [];
    })
    .toSorted((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return submitted.at(-1) ?? null;
}

/**
 * Unresolved threads, and those waiting on me: the last comment isn't mine,
 * and the thread is mine to answer (my PR, or I started it).
 */
function threadCounts(pr: GhPullRequest, viewer: string): PullRequestSummary["threads"] {
  const mine = pr.author?.login === viewer;
  let unresolved = 0;
  let waitingOnMe = 0;
  for (const thread of compact(pr.reviewThreads)) {
    if (thread.isResolved) continue;
    unresolved += 1;
    const first = compact(thread.firstComment)[0]?.author?.login;
    const last = compact(thread.lastComment)[0]?.author?.login;
    if (last !== viewer && (mine || first === viewer)) waitingOnMe += 1;
  }
  return { unresolved, waitingOnMe };
}

function checks(pr: GhPullRequest): { ci: PrCiState; failingChecks: string[] } {
  const rollup = compact(pr.commits)[0]?.commit.statusCheckRollup ?? null;
  const failing = compact(rollup?.contexts).flatMap((c) => {
    if (c.kind === "CheckRun" && FAILED_CONCLUSIONS.has(c.conclusion ?? "")) {
      return [c.name ?? "check"];
    }
    if (c.kind === "StatusContext" && FAILED_STATUSES.has(c.state ?? "")) {
      return [c.context ?? "status"];
    }
    return [];
  });
  return { ci: ciState(rollup?.state), failingChecks: [...new Set(failing)].slice(0, 5) };
}

export interface SummaryContext {
  viewer: string;
  /** The PR came from the team review-request search. */
  teamRequested?: boolean;
}

export function toSummary(pr: GhPullRequest, context: SummaryContext): PullRequestSummary {
  const { viewer } = context;
  const requestedFromMe = compact(pr.reviewRequests).some(
    (r) => r.requestedReviewer?.kind === "User" && r.requestedReviewer.login === viewer,
  );
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
    isDraft: pr.isDraft,
    author: toActor(pr.author),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headOid: pr.headRefOid,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    ...checks(pr),
    reviewers: reviewers(pr),
    myLastReview: myLastReview(pr),
    requestedFromMe,
    requestedFromMyTeam: !requestedFromMe && (context.teamRequested ?? false),
    assignedToMe: compact(pr.assignees).some((a) => a.login === viewer),
    threads: threadCounts(pr, viewer),
    comments: pr.comments.totalCount,
    labels: compact(pr.labels).map(({ name, color }) => ({ name, color })),
  };
}
