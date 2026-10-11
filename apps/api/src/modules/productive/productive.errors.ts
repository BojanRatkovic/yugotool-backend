import { DomainError } from "../../common/errors/domain.error";

/** Productive answered 401: the token is wrong, revoked or expired. */
export class ProductiveTokenInvalidError extends DomainError {
  readonly code = "productive_token_invalid";
  readonly kind = "validation";
}

/** The token reaches several organizations; `details.organizations` lists them. */
export class ProductivePickOrganizationError extends DomainError {
  readonly code = "productive_pick_organization";
  readonly kind = "conflict";
}

/** The picked organization isn't one the token reaches. */
export class ProductiveOrganizationUnknownError extends DomainError {
  readonly code = "productive_organization_unknown";
  readonly kind = "validation";
}

export class ProductiveNotConnectedError extends DomainError {
  readonly code = "productive_not_connected";
  readonly kind = "unprocessable";
}

/** Productive answered 403: no access to the organization or the record. */
export class ProductiveForbiddenError extends DomainError {
  readonly code = "productive_forbidden";
  readonly kind = "unprocessable";
}

export class ProductiveNotFoundError extends DomainError {
  readonly code = "productive_not_found";
  readonly kind = "not_found";
}

export class ProductiveRateLimitedError extends DomainError {
  readonly code = "productive_rate_limited";
  readonly kind = "rate_limited";
}

/** Productive is unreachable or answered with an error we can't act on. */
export class ProductiveUnavailableError extends DomainError {
  readonly code = "productive_unavailable";
  readonly kind = "bad_gateway";
}
