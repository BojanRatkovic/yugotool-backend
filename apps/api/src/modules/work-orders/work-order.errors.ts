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
