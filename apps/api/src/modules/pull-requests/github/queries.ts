/**
 * GraphQL documents for GitHub (spec 0008 §5.3). Search strings and the
 * viewer's login travel as variables, never interpolated.
 */

export const VIEWER = /* GraphQL */ `
  query Viewer {
    viewer {
      login
    }
  }
`;

/** What a board card needs. `$viewer` scopes `myReviews` to my own reviews. */
const PR_FIELDS = /* GraphQL */ `
  fragment PrFields on PullRequest {
    id
    number
    title
    url
    state
    isDraft
    author {
      login
      avatarUrl
    }
    headRefName
    baseRefName
    headRefOid
    additions
    deletions
    changedFiles
    createdAt
    updatedAt
    mergedAt
    reviewDecision
    mergeable
    comments {
      totalCount
    }
    labels(first: 5) {
      nodes {
        name
        color
      }
    }
    assignees(first: 10) {
      nodes {
        login
      }
    }
    reviewRequests(first: 10) {
      nodes {
        requestedReviewer {
          kind: __typename
          ... on User {
            login
            avatarUrl
          }
          ... on Team {
            name
          }
        }
      }
    }
    latestReviews(first: 10) {
      nodes {
        state
        author {
          login
          avatarUrl
        }
      }
    }
    myReviews: reviews(last: 5, author: $viewer) {
      nodes {
        state
        submittedAt
        commit {
          oid
        }
      }
    }
    reviewThreads(first: 30) {
      nodes {
        isResolved
        firstComment: comments(first: 1) {
          nodes {
            author {
              login
            }
          }
        }
        lastComment: comments(last: 1) {
          nodes {
            author {
              login
            }
          }
        }
      }
    }
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            state
            contexts(first: 20) {
              nodes {
                kind: __typename
                ... on CheckRun {
                  name
                  conclusion
                }
                ... on StatusContext {
                  context
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * GitHub's GraphQL budget is 5000 points an hour and a search that pulls full
 * PR fields costs ~130 (50 PRs × their nested lists). So a board polls with a
 * cheap search (~1 point) that returns only what tells a PR changed, and
 * fetches full fields (PRS_BY_ID) just for the PRs whose fingerprint moved.
 */
export const SEARCH_FINGERPRINTS = /* GraphQL */ `
  query SearchFingerprints($query: String!) {
    search(query: $query, type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          id
          number
          state
          updatedAt
          headRefOid
          mergeable
          reviewDecision
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Full card fields for up to 25 PRs at a time (cost grows with the count). */
export const PRS_BY_ID = /* GraphQL */ `
  query PrsById($ids: [ID!]!, $viewer: String!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        ...PrFields
      }
    }
  }
  ${PR_FIELDS}
`;

// ── Detail (several requests in parallel; see SEARCH_PRS) ──────────────────

/** The PR's card fields plus what the panel header and Checks/Commits tabs need. */
export const PR_DETAIL = /* GraphQL */ `
  query PrDetail($owner: String!, $name: String!, $number: Int!, $viewer: String!) {
    repository(owner: $owner, name: $name) {
      viewerPermission
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequest(number: $number) {
        ...PrFields
        bodyHTML
        viewerCanUpdate
        pendingReviews: reviews(first: 1, states: PENDING, author: $viewer) {
          nodes {
            id
            comments {
              totalCount
            }
          }
        }
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    kind: __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                      checkSuite {
                        workflowRun {
                          workflow {
                            name
                          }
                        }
                      }
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
        commitList: commits(last: 100) {
          totalCount
          nodes {
            commit {
              oid
              messageHeadline
              committedDate
              author {
                name
                user {
                  login
                  avatarUrl
                }
              }
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    }
  }
  ${PR_FIELDS}
`;

/**
 * What tells an open panel that something changed (~1 point): activity moves
 * updatedAt, but CI progress and resolving a thread don't, so they're here too.
 */
export const PR_FINGERPRINT = /* GraphQL */ `
  query PrFingerprint($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        updatedAt
        headRefOid
        mergeable
        reviewDecision
        state
        isDraft
        reviewThreads(first: 100) {
          nodes {
            isResolved
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 1) {
                  checkRunCountsByState {
                    state
                    count
                  }
                  statusContextCountsByState {
                    state
                    count
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const PR_THREADS = /* GraphQL */ `
  query PrThreads($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          totalCount
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            originalLine
            diffSide
            viewerCanResolve
            viewerCanUnresolve
            viewerCanReply
            comments(first: 30) {
              nodes {
                id
                diffHunk
                bodyHTML
                createdAt
                state
                author {
                  login
                  avatarUrl
                }
                pullRequestReview {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const PR_FILES = /* GraphQL */ `
  query PrFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        files(first: 100, after: $after) {
          totalCount
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            path
            additions
            deletions
            changeType
            viewerViewedState
          }
        }
      }
    }
  }
`;

const ACTOR = "actor { login avatarUrl }";

/** Newest first in pages of 100 (read backwards), so a long history keeps its end. */
export const PR_TIMELINE = /* GraphQL */ `
  query PrTimeline($owner: String!, $name: String!, $number: Int!, $before: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        timelineItems(
          last: 100
          before: $before
          itemTypes: [
            ISSUE_COMMENT
            PULL_REQUEST_REVIEW
            PULL_REQUEST_COMMIT
            HEAD_REF_FORCE_PUSHED_EVENT
            READY_FOR_REVIEW_EVENT
            REVIEW_REQUESTED_EVENT
            MERGED_EVENT
            CLOSED_EVENT
            REOPENED_EVENT
            RENAMED_TITLE_EVENT
          ]
        ) {
          totalCount
          pageInfo {
            hasPreviousPage
            startCursor
          }
          nodes {
            kind: __typename
            ... on IssueComment {
              id
              bodyHTML
              createdAt
              author {
                login
                avatarUrl
              }
            }
            ... on PullRequestReview {
              id
              state
              bodyHTML
              createdAt
              submittedAt
              author {
                login
                avatarUrl
              }
            }
            ... on PullRequestCommit {
              commit {
                oid
                committedDate
                author {
                  user {
                    login
                    avatarUrl
                  }
                }
              }
            }
            ... on HeadRefForcePushedEvent {
              createdAt
              ${ACTOR}
            }
            ... on ReadyForReviewEvent {
              createdAt
              ${ACTOR}
            }
            ... on ReviewRequestedEvent {
              createdAt
              ${ACTOR}
              requestedReviewer {
                kind: __typename
                ... on User {
                  login
                }
                ... on Team {
                  name
                }
              }
            }
            ... on MergedEvent {
              createdAt
              ${ACTOR}
            }
            ... on ClosedEvent {
              createdAt
              ${ACTOR}
            }
            ... on ReopenedEvent {
              createdAt
              ${ACTOR}
            }
            ... on RenamedTitleEvent {
              createdAt
              ${ACTOR}
              previousTitle
              currentTitle
            }
          }
        }
      }
    }
  }
`;

// ── Writes ──────────────────────────────────────────────────────────────────

/** The PR's node id and my pending review, which every write starts from. */
export const PR_WRITE_TARGET = /* GraphQL */ `
  query PrWriteTarget($owner: String!, $name: String!, $number: Int!, $viewer: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        headRefOid
        pendingReviews: reviews(first: 1, states: PENDING, author: $viewer) {
          nodes {
            id
            body
            comments {
              totalCount
            }
          }
        }
      }
    }
  }
`;

export const ADD_COMMENT = /* GraphQL */ `
  mutation AddComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      clientMutationId
    }
  }
`;

export const ADD_THREAD_REPLY = /* GraphQL */ `
  mutation AddThreadReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      clientMutationId
    }
  }
`;

export const RESOLVE_THREAD = /* GraphQL */ `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      clientMutationId
    }
  }
`;

export const UNRESOLVE_THREAD = /* GraphQL */ `
  mutation UnresolveThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      clientMutationId
    }
  }
`;

/** Without `event` the review stays PENDING (mine, invisible to others). */
export const ADD_REVIEW = /* GraphQL */ `
  mutation AddReview($pullRequestId: ID!, $event: PullRequestReviewEvent, $body: String) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, event: $event, body: $body }) {
      pullRequestReview {
        id
      }
    }
  }
`;

export const ADD_REVIEW_THREAD = /* GraphQL */ `
  mutation AddReviewThread(
    $reviewId: ID!
    $path: String!
    $line: Int!
    $side: DiffSide!
    $startLine: Int
    $startSide: DiffSide
    $body: String!
  ) {
    addPullRequestReviewThread(
      input: {
        pullRequestReviewId: $reviewId
        path: $path
        line: $line
        side: $side
        startLine: $startLine
        startSide: $startSide
        body: $body
      }
    ) {
      thread {
        id
      }
    }
  }
`;

export const SUBMIT_REVIEW = /* GraphQL */ `
  mutation SubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
      clientMutationId
    }
  }
`;

export const DELETE_REVIEW = /* GraphQL */ `
  mutation DeleteReview($reviewId: ID!) {
    deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
      clientMutationId
    }
  }
`;

export const MARK_FILE_VIEWED = /* GraphQL */ `
  mutation MarkFileViewed($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      clientMutationId
    }
  }
`;

export const UNMARK_FILE_VIEWED = /* GraphQL */ `
  mutation UnmarkFileViewed($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
      clientMutationId
    }
  }
`;

export const MARK_READY = /* GraphQL */ `
  mutation MarkReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      clientMutationId
    }
  }
`;

export const MERGE_PR = /* GraphQL */ `
  mutation MergePr($pullRequestId: ID!, $method: PullRequestMergeMethod!) {
    mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: $method }) {
      clientMutationId
    }
  }
`;

/**
 * What a YugoTool review freezes at start (spec 0009): the raw markdown body,
 * both commits and the unresolved threads (first comment each). ~1 point.
 */
export const PR_REVIEW_SNAPSHOT = /* GraphQL */ `
  query PrReviewSnapshot($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        title
        url
        body
        state
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 1) {
              nodes {
                body
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Rewrites my pending review's summary (YugoTool findings without a line go there). */
export const UPDATE_REVIEW_BODY = /* GraphQL */ `
  mutation UpdateReviewBody($reviewId: ID!, $body: String!) {
    updatePullRequestReview(input: { pullRequestReviewId: $reviewId, body: $body }) {
      clientMutationId
    }
  }
`;
