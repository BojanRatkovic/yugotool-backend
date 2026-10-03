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
