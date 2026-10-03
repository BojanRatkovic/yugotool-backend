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
export const PR_FIELDS = /* GraphQL */ `
  fragment PrFields on PullRequest {
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
    labels(first: 10) {
      nodes {
        name
        color
      }
    }
    assignees(first: 20) {
      nodes {
        login
      }
    }
    reviewRequests(first: 20) {
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
    latestReviews(first: 20) {
      nodes {
        state
        author {
          login
          avatarUrl
        }
      }
    }
    myReviews: reviews(last: 10, author: $viewer) {
      nodes {
        state
        submittedAt
        commit {
          oid
        }
      }
    }
    reviewThreads(first: 50) {
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
            contexts(first: 30) {
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
 * One search (a board runs several in parallel: a single request with all of
 * them times out on GitHub for busy repos).
 */
export const SEARCH_PRS = /* GraphQL */ `
  query SearchPrs($viewer: String!, $query: String!) {
    search(query: $query, type: ISSUE, first: 50) {
      issueCount
      nodes {
        ... on PullRequest {
          ...PrFields
        }
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
            comments(first: 50) {
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
              comments(first: 100) {
                nodes {
                  id
                }
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
