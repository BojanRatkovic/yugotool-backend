import { DomainError } from "../../common/errors/domain.error";

export class WorkOrderNotFoundError extends DomainError {
  readonly code = "work_order_not_found";
  readonly kind = "not_found";
}

export class WorkOrderNotStartableError extends DomainError {
  readonly code = "work_order_not_startable";
  readonly kind = "conflict";
}

export class WorkOrderNotQueuedError extends DomainError {
  readonly code = "work_order_not_queued";
  readonly kind = "conflict";
}

export class WorkOrderNotRunningError extends DomainError {
  readonly code = "work_order_not_running";
  readonly kind = "conflict";
}

export class PullRequestNotPossibleError extends DomainError {
  readonly code = "pull_request_not_possible";
  readonly kind = "conflict";
}

export class PullRequestFailedError extends DomainError {
  readonly code = "pull_request_failed";
  readonly kind = "conflict";
}

export class CiNotAvailableError extends DomainError {
  readonly code = "ci_not_available";
  readonly kind = "conflict";
}
