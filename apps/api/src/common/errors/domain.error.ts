export type DomainErrorKind =
  | "not_found"
  | "conflict"
  | "validation"
  | "unauthenticated"
  | "forbidden"
  /** The request is fine but the setup can't serve it (422). */
  | "unprocessable"
  /** An upstream service (GitHub) failed (502). */
  | "bad_gateway";

/**
 * Base class for typed domain errors thrown by services. Translation to HTTP
 * status codes happens only in the global exception filter.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly kind: DomainErrorKind;
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}
