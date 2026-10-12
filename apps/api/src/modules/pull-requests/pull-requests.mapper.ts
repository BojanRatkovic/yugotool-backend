import type {
  PrActor,
  PrCheck,
  PrCiState,
  PrFile,
  PrReviewer,
  PrReviewState,
  PrThread,
  PrTimelineItem,
  PullRequestDetail,
  PullRequestSummary,
} from "@yugotool/contracts";
import { prFileSchema, prReviewStateSchema } from "@yugotool/contracts";
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

const ghPullRequestSchema = z.object({
  id: z.string(),
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

/** PRS_BY_ID: full fields per node id; ids that aren't (or no longer are) PRs come back null or `{}`. */
export const ghNodesSchema = z.object({
  nodes: z.array(z.union([ghPullRequestSchema, z.object({}).strict()]).nullable()),
});

export function pullRequestNodes(data: z.infer<typeof ghNodesSchema>): GhPullRequest[] {
  return data.nodes.filter((n): n is GhPullRequest => n !== null && "number" in n);
}

/** SEARCH_FINGERPRINTS: just what tells that a PR changed. */
const ghFingerprintSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  state: z.string(),
  updatedAt: z.string(),
  headRefOid: z.string(),
  mergeable: z.string(),
  reviewDecision: z.string().nullable(),
  commits: nodes(
    z.object({
      commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }),
    }),
  ),
});
export type GhFingerprint = z.infer<typeof ghFingerprintSchema>;

export const ghFingerprintSearchSchema = z.object({
  search: z.object({
    nodes: z.array(z.union([ghFingerprintSchema, z.object({}).strict()]).nullable()),
  }),
});

export function fingerprints(data: z.infer<typeof ghFingerprintSearchSchema>): GhFingerprint[] {
  return data.search.nodes.filter((n): n is GhFingerprint => n !== null && "number" in n);
}

/** One string that changes whenever the PR's card would. */
export function fingerprintKey(pr: GhFingerprint): string {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "none";
  return [pr.state, pr.updatedAt, pr.headRefOid, pr.mergeable, pr.reviewDecision, rollup].join("|");
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const GHOST: PrActor = { login: "ghost", avatarUrl: "" };
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);

const compact = <T>(list: { nodes: (T | null)[] } | null | undefined): T[] =>
  (list?.nodes ?? []).filter((n): n is T => n !== null);

function toActor(actor: { login: string; avatarUrl?: string | undefined } | null): PrActor {
  return actor ? { login: actor.login, avatarUrl: actor.avatarUrl ?? "" } : GHOST;
}

/** The head commit's check rollup as one state. */
function ciState(rollupState: string | null | undefined): PrCiState {
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
function threadCounts(
  threads: { isResolved: boolean; first: string | undefined; last: string | undefined }[],
  prAuthor: string | undefined,
  viewer: string,
): PullRequestSummary["threads"] {
  const open = threads.filter((t) => !t.isResolved);
  return {
    unresolved: open.length,
    waitingOnMe: open.filter(
      (t) => t.last !== viewer && (prAuthor === viewer || t.first === viewer),
    ).length,
  };
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
    threads: threadCounts(
      compact(pr.reviewThreads).map((t) => ({
        isResolved: t.isResolved,
        first: compact(t.firstComment)[0]?.author?.login,
        last: compact(t.lastComment)[0]?.author?.login,
      })),
      pr.author?.login,
      viewer,
    ),
    comments: pr.comments.totalCount,
    labels: compact(pr.labels).map(({ name, color }) => ({ name, color })),
  };
}

// ── Detail ──────────────────────────────────────────────────────────────────

const ghCheckContextSchema = z.object({
  kind: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  checkSuite: z
    .object({
      workflowRun: z.object({ workflow: z.object({ name: z.string() }) }).nullable(),
    })
    .nullable()
    .optional(),
  context: z.string().optional(),
  state: z.string().optional(),
  targetUrl: z.string().nullable().optional(),
});

export const ghDetailSchema = z.object({
  repository: z.object({
    viewerPermission: z.string().nullable(),
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    pullRequest: ghPullRequestSchema
      .extend({
        bodyHTML: z.string(),
        viewerCanUpdate: z.boolean(),
        pendingReviews: nodes(
          z.object({ id: z.string(), comments: z.object({ totalCount: z.number().int() }) }),
        ).nullable(),
        headCommit: nodes(
          z.object({
            commit: z.object({
              statusCheckRollup: z.object({ contexts: nodes(ghCheckContextSchema) }).nullable(),
            }),
          }),
        ),
        commitList: z.object({
          totalCount: z.number().int(),
          nodes: z.array(
            z
              .object({
                commit: z.object({
                  oid: z.string(),
                  messageHeadline: z.string(),
                  committedDate: z.string(),
                  author: z
                    .object({
                      name: z.string().nullable(),
                      user: ghActorSchema,
                    })
                    .nullable(),
                  statusCheckRollup: z.object({ state: z.string() }).nullable(),
                }),
              })
              .nullable(),
          ),
        }),
      })
      .nullable(),
  }),
});
export type GhDetail = z.infer<typeof ghDetailSchema>;

export const ghThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        reviewThreads: z.object({
          totalCount: z.number().int(),
          nodes: z.array(
            z
              .object({
                id: z.string(),
                isResolved: z.boolean(),
                isOutdated: z.boolean(),
                path: z.string(),
                line: z.number().int().nullable(),
                startLine: z.number().int().nullable(),
                originalLine: z.number().int().nullable(),
                diffSide: z.enum(["LEFT", "RIGHT"]),
                viewerCanResolve: z.boolean(),
                viewerCanUnresolve: z.boolean(),
                viewerCanReply: z.boolean(),
                comments: nodes(
                  z.object({
                    id: z.string(),
                    diffHunk: z.string(),
                    bodyHTML: z.string(),
                    createdAt: z.string(),
                    state: z.string(),
                    author: ghActorSchema,
                    pullRequestReview: z.object({ id: z.string() }).nullable(),
                  }),
                ),
              })
              .nullable(),
          ),
        }),
      })
      .nullable(),
  }),
});
export type GhThreads = z.infer<typeof ghThreadsSchema>;

export const ghFilesSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        files: z
          .object({
            totalCount: z.number().int(),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(
              z
                .object({
                  path: z.string(),
                  additions: z.number().int(),
                  deletions: z.number().int(),
                  changeType: prFileSchema.shape.changeType,
                  viewerViewedState: z.string(),
                })
                .nullable(),
            ),
          })
          .nullable(),
      })
      .nullable(),
  }),
});
export type GhFiles = z.infer<typeof ghFilesSchema>;

const ghTimelineNodeSchema = z.object({
  kind: z.string(),
  id: z.string().optional(),
  bodyHTML: z.string().optional(),
  createdAt: z.string().optional(),
  submittedAt: z.string().nullable().optional(),
  state: z.string().optional(),
  author: ghActorSchema.optional(),
  actor: ghActorSchema.optional(),
  commit: z
    .object({
      oid: z.string(),
      committedDate: z.string(),
      author: z.object({ user: ghActorSchema }).nullable(),
    })
    .optional(),
  requestedReviewer: z
    .object({ kind: z.string(), login: z.string().optional(), name: z.string().optional() })
    .nullable()
    .optional(),
  previousTitle: z.string().optional(),
  currentTitle: z.string().optional(),
});
export type GhTimelineNode = z.infer<typeof ghTimelineNodeSchema>;

export const ghTimelineSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        timelineItems: z.object({
          totalCount: z.number().int(),
          pageInfo: z.object({
            hasPreviousPage: z.boolean(),
            startCursor: z.string().nullable(),
          }),
          nodes: z.array(ghTimelineNodeSchema.nullable()),
        }),
      })
      .nullable(),
  }),
});
export type GhTimeline = z.infer<typeof ghTimelineSchema>;

type GhFile = NonNullable<
  NonNullable<NonNullable<GhFiles["repository"]["pullRequest"]>["files"]>["nodes"][number]
>;
type GhThread = NonNullable<
  NonNullable<GhThreads["repository"]["pullRequest"]>["reviewThreads"]["nodes"][number]
>;
type GhCheckContext = z.infer<typeof ghCheckContextSchema>;

const WRITE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

function toCheck(context: GhCheckContext): PrCheck {
  if (context.kind === "StatusContext") {
    const state = context.state ?? "";
    return {
      name: context.context ?? "status",
      state: state === "SUCCESS" ? "pass" : FAILED_STATUSES.has(state) ? "fail" : "pending",
      url: context.targetUrl ?? null,
      workflow: null,
    };
  }
  return {
    name: context.name ?? "check",
    state: checkRunState(context.status, context.conclusion),
    url: context.detailsUrl ?? null,
    workflow: context.checkSuite?.workflowRun?.workflow.name ?? null,
  };
}

function checkRunState(status: string | undefined, conclusion: string | null | undefined) {
  if (status !== "COMPLETED") return "pending" as const;
  switch (conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
      return "pass" as const;
    case "SKIPPED":
    case "STALE":
      return "skipping" as const;
    case "CANCELLED":
      return "cancel" as const;
    default:
      return "fail" as const;
  }
}

/** Failing first, then pending, passed, skipped, cancelled (the Checks tab's order). */
const CHECK_ORDER: Record<PrCheck["state"], number> = {
  fail: 0,
  pending: 1,
  pass: 2,
  skipping: 3,
  cancel: 4,
};

function toThread(thread: GhThread): PrThread {
  const comments = compact(thread.comments);
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    side: thread.diffSide,
    diffHunk: comments[0]?.diffHunk ?? "",
    viewerCanResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
    viewerCanReply: thread.viewerCanReply,
    comments: comments.map((c) => ({
      id: c.id,
      author: toActor(c.author),
      bodyHtml: c.bodyHTML,
      createdAt: c.createdAt,
      isPending: c.state === "PENDING",
    })),
  };
}

function toFile(file: GhFile): PrFile {
  return {
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    changeType: file.changeType,
    viewed: file.viewerViewedState === "VIEWED",
  };
}

const actorOf = (node: GhTimelineNode): PrActor | null => (node.actor ? toActor(node.actor) : null);

type PlainEvent = Extract<
  PrTimelineItem,
  { kind: "force_push" | "ready_for_review" | "closed" | "reopened" }
>["kind"];

/** Events that are just "who did it, when". */
const PLAIN_EVENTS: Record<string, PlainEvent> = {
  HeadRefForcePushedEvent: "force_push",
  ReadyForReviewEvent: "ready_for_review",
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
};

function reviewItem(
  node: GhTimelineNode,
  threadIdsByReviewId: ReadonlyMap<string, string[]>,
): PrTimelineItem | null {
  const state = reviewState(node.state ?? "");
  if (!state || state === "PENDING") return null;
  const threadIds = threadIdsByReviewId.get(node.id ?? "") ?? [];
  return {
    kind: "review",
    id: node.id ?? "",
    author: toActor(node.author ?? null),
    state,
    bodyHtml: node.bodyHTML ?? "",
    createdAt: node.submittedAt ?? node.createdAt ?? "",
    threadIds: [...new Set(threadIds)],
  };
}

/** Adds a commit, folding it into the previous item when that is the same author's commits. */
function pushCommit(items: PrTimelineItem[], commit: NonNullable<GhTimelineNode["commit"]>): void {
  const author = commit.author?.user ? toActor(commit.author.user) : null;
  const last = items.at(-1);
  if (last?.kind === "commits" && last.author?.login === author?.login) {
    last.count += 1;
    last.oids.push(commit.oid);
    return;
  }
  items.push({
    kind: "commits",
    count: 1,
    oids: [commit.oid],
    createdAt: commit.committedDate,
    author,
  });
}

/** Every kind but commits and reviews: one node, at most one item. */
function eventItem(node: GhTimelineNode): PrTimelineItem | null {
  const createdAt = node.createdAt ?? "";
  const plain = PLAIN_EVENTS[node.kind];
  if (plain && Object.hasOwn(PLAIN_EVENTS, node.kind)) {
    return { kind: plain, createdAt, author: actorOf(node) };
  }
  switch (node.kind) {
    case "IssueComment":
      return {
        kind: "comment",
        id: node.id ?? "",
        author: toActor(node.author ?? null),
        bodyHtml: node.bodyHTML ?? "",
        createdAt,
      };
    case "ReviewRequestedEvent": {
      const reviewer = node.requestedReviewer?.login ?? node.requestedReviewer?.name;
      return reviewer
        ? { kind: "review_requested", createdAt, author: actorOf(node), reviewer }
        : null;
    }
    case "MergedEvent":
      return { kind: "merged", createdAt, by: actorOf(node) };
    case "RenamedTitleEvent":
      return {
        kind: "renamed",
        createdAt,
        author: actorOf(node),
        from: node.previousTitle ?? "",
        to: node.currentTitle ?? "",
      };
    default:
      return null;
  }
}

/**
 * Timeline items, oldest first. Consecutive commits by the same author become
 * one `commits` item; my pending review and unknown kinds are left out.
 */
export function toTimeline(
  timelineNodes: GhTimelineNode[],
  threadIdsByReviewId: ReadonlyMap<string, string[]>,
): PrTimelineItem[] {
  const items: PrTimelineItem[] = [];
  for (const node of timelineNodes) {
    if (node.kind === "PullRequestCommit") {
      if (node.commit) pushCommit(items, node.commit);
      continue;
    }
    const item =
      node.kind === "PullRequestReview" ? reviewItem(node, threadIdsByReviewId) : eventItem(node);
    if (item) items.push(item);
  }
  return items;
}

export interface DetailParts {
  detail: GhDetail["repository"];
  pr: NonNullable<GhDetail["repository"]["pullRequest"]>;
  threads: GhThread[];
  threadsTotal: number;
  files: GhFile[];
  filesTotal: number;
  timeline: GhTimelineNode[];
  timelineTruncated: boolean;
}

export function toDetail(parts: DetailParts, viewer: string): PullRequestDetail {
  const { detail, pr } = parts;
  const summary = toSummary(pr, { viewer });
  const threads = parts.threads.map(toThread);
  const threadIdsByReviewId = new Map<string, string[]>();
  for (const thread of parts.threads) {
    for (const comment of compact(thread.comments)) {
      const reviewId = comment.pullRequestReview?.id;
      if (!reviewId) continue;
      const ids = threadIdsByReviewId.get(reviewId) ?? [];
      if (!ids.includes(thread.id)) ids.push(thread.id);
      threadIdsByReviewId.set(reviewId, ids);
    }
  }
  const pending = compact(pr.pendingReviews)[0];
  const contexts = compact(compact(pr.headCommit)[0]?.commit.statusCheckRollup?.contexts);
  return {
    ...summary,
    threads: threadCounts(
      threads.map((t) => ({
        isResolved: t.isResolved,
        first: t.comments[0]?.author.login,
        last: t.comments.at(-1)?.author.login,
      })),
      pr.author?.login,
      viewer,
    ),
    bodyHtml: pr.bodyHTML,
    viewerCanUpdate: pr.viewerCanUpdate,
    viewerCanMerge: pr.state === "OPEN" && WRITE_PERMISSIONS.has(detail.viewerPermission ?? ""),
    mergeMethods: [
      ...(detail.mergeCommitAllowed ? (["merge"] as const) : []),
      ...(detail.squashMergeAllowed ? (["squash"] as const) : []),
      ...(detail.rebaseMergeAllowed ? (["rebase"] as const) : []),
    ],
    pendingReview: pending ? { id: pending.id, comments: pending.comments.totalCount } : null,
    checks: contexts.map(toCheck).toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]),
    files: parts.files.map(toFile),
    reviewThreads: threads,
    timeline: toTimeline(parts.timeline, threadIdsByReviewId),
    commits: compact(pr.commitList).map(({ commit }) => ({
      oid: commit.oid,
      messageHeadline: commit.messageHeadline,
      author: commit.author?.user
        ? toActor(commit.author.user)
        : commit.author?.name
          ? { login: commit.author.name, avatarUrl: "" }
          : null,
      committedAt: commit.committedDate,
      ci: ciState(commit.statusCheckRollup?.state),
    })),
    truncated: {
      files: parts.filesTotal > parts.files.length,
      threads: parts.threadsTotal > parts.threads.length,
      timeline: parts.timelineTruncated,
      commits: pr.commitList.totalCount > pr.commitList.nodes.length,
    },
  };
}
