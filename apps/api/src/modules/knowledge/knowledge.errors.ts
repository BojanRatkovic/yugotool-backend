import { DomainError } from "../../common/errors/domain.error";

export class KnowledgeSourceNotFoundError extends DomainError {
  readonly code = "knowledge_source_not_found";
  readonly kind = "not_found";
}

export class KnowledgeLocationInvalidError extends DomainError {
  readonly code = "knowledge_location_invalid";
  readonly kind = "validation";
}

export class KnowledgeSourceInUseError extends DomainError {
  readonly code = "knowledge_source_in_use";
  readonly kind = "conflict";
}

export class KnowledgeProjectNotFoundError extends DomainError {
  readonly code = "project_not_found";
  readonly kind = "not_found";
}
