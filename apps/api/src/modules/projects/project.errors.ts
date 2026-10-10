import { DomainError } from "../../common/errors/domain.error";

export class ProjectNotFoundError extends DomainError {
  readonly code = "project_not_found";
  readonly kind = "not_found";
}

export class RepoPathInvalidError extends DomainError {
  readonly code = "repo_path_invalid";
  readonly kind = "validation";
}

/** The path is a work hub, not a code repo: pick one of its repos (spec 0012). */
export class RepoPathIsHubError extends DomainError {
  readonly code = "repo_path_is_hub";
  readonly kind = "validation";
}

/** Not a repo of this hub project (or the project is not a hub). */
export class HubRepoNotFoundError extends DomainError {
  readonly code = "hub_repo_not_found";
  readonly kind = "not_found";
}

export class PreviewNotConfiguredError extends DomainError {
  readonly code = "preview_not_configured";
  readonly kind = "conflict";
}

export class PreviewTestRunningError extends DomainError {
  readonly code = "preview_test_running";
  readonly kind = "conflict";
}

export class PreviewScreenshotMissingError extends DomainError {
  readonly code = "preview_screenshot_missing";
  readonly kind = "not_found";
}

export class RouteDiscoveryRunningError extends DomainError {
  readonly code = "route_discovery_running";
  readonly kind = "conflict";
}

export class ProjectHasActiveWorkError extends DomainError {
  readonly code = "project_has_active_work";
  readonly kind = "conflict";
}

export class PreviewSignInRunningError extends DomainError {
  readonly code = "preview_sign_in_running";
  readonly kind = "conflict";
}

export class PreviewSignInNotRunningError extends DomainError {
  readonly code = "preview_sign_in_not_running";
  readonly kind = "conflict";
}
