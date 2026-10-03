import { DomainError } from "../../common/errors/domain.error";

/** The project can't show pull requests: not on GitHub, or gh missing / logged out. */
export class PullRequestsUnavailableError extends DomainError {
  readonly code = "pull_requests_unavailable";
  readonly kind = "unprocessable";
}

/** `gh` isn't installed. A setup problem, so the UI shows a hint, not an error. */
export class GhMissingError extends PullRequestsUnavailableError {
  constructor() {
    super("The GitHub CLI (gh) isn't installed.");
  }
}

/** `gh` is installed but not logged in. */
export class GhNotLoggedInError extends PullRequestsUnavailableError {
  constructor() {
    super("The GitHub CLI isn't logged in (gh auth login).");
  }
}

/** GitHub (or gh) refused or failed; the message is GitHub's. */
export class GithubError extends DomainError {
  readonly code = "github_error";
  readonly kind = "bad_gateway";

  constructor(
    message: string,
    /** HTTP status GitHub answered with, when gh reported one. */
    readonly httpStatus: number | null = null,
    /** GraphQL error type (NOT_FOUND, UNPROCESSABLE, FORBIDDEN…), when any. */
    readonly type: string | null = null,
  ) {
    super(message);
  }
}

export class PullRequestNotFoundError extends DomainError {
  readonly code = "pull_request_not_found";
  readonly kind = "not_found";
}

export class PullRequestsProjectNotFoundError extends DomainError {
  readonly code = "project_not_found";
  readonly kind = "not_found";
}

/** The `since` commit isn't on GitHub any more (force push); the UI falls back to the full diff. */
export class SinceUnknownError extends DomainError {
  readonly code = "since_unknown";
  readonly kind = "conflict";
}

/** GitHub refused a write (e.g. approving your own PR); the message is GitHub's. */
export class GithubRefusedError extends DomainError {
  readonly code = "github_refused";
  readonly kind = "unprocessable";
}

/** REQUEST_CHANGES / COMMENT without a body or pending comments (GitHub's rule). */
export class ReviewBodyRequiredError extends DomainError {
  readonly code = "review_body_required";
  readonly kind = "unprocessable";
}

/** GitHub won't merge (checks, reviews, conflicts…); the message is GitHub's. */
export class MergeRefusedError extends DomainError {
  readonly code = "merge_refused";
  readonly kind = "conflict";
}
