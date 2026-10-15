import { DomainError } from "../../common/errors/domain.error";

/**
 * The project's repo isn't on GitHub (or gh can't reach it), so there are no
 * community standards to read. A setup problem, surfaced as 422 with a hint.
 */
export class CommunityUnavailableError extends DomainError {
  readonly code = "community_unavailable";
  readonly kind = "unprocessable";
}
