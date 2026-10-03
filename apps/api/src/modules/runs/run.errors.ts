import { DomainError } from "../../common/errors/domain.error";

export class RunNotFoundError extends DomainError {
  readonly code = "run_not_found";
  readonly kind = "not_found";
}

export class WorkspaceGoneError extends DomainError {
  readonly code = "workspace_gone";
  readonly kind = "conflict";
}

export class GateNotPendingError extends DomainError {
  readonly code = "gate_not_pending";
  readonly kind = "conflict";
}

export class ShiftNotRunningError extends DomainError {
  readonly code = "shift_not_running";
  readonly kind = "conflict";
}

export class ShiftReviewNotPendingError extends DomainError {
  readonly code = "shift_review_not_pending";
  readonly kind = "conflict";
}

export class QaCheckNotFoundError extends DomainError {
  readonly code = "qa_check_not_found";
  readonly kind = "not_found";
}

export class QaCheckNotAcceptableError extends DomainError {
  readonly code = "qa_check_not_acceptable";
  readonly kind = "conflict";
}

export class ArtifactNotFoundError extends DomainError {
  readonly code = "artifact_not_found";
  readonly kind = "not_found";
}
