import { DomainError } from "../../common/errors/domain.error";

export class ClaudeAccountNotFoundError extends DomainError {
  readonly code = "claude_account_not_found";
  readonly kind = "not_found";
}

export class ClaudeAccountExistsError extends DomainError {
  readonly code = "claude_account_exists";
  readonly kind = "conflict";
}

/** The dir is missing, or `claude` is not signed in there. */
export class ClaudeConfigDirInvalidError extends DomainError {
  readonly code = "claude_config_dir_invalid";
  readonly kind = "validation";
}

/** Sign in again works only for accounts that sign in through a config dir. */
export class ClaudeLoginNotSupportedError extends DomainError {
  readonly code = "claude_login_not_supported";
  readonly kind = "validation";
}

export class ClaudeLoginNotFoundError extends DomainError {
  readonly code = "claude_login_not_found";
  readonly kind = "not_found";
}

export class ClaudeLoginFinishedError extends DomainError {
  readonly code = "claude_login_finished";
  readonly kind = "conflict";
}
