import { randomUUID } from "node:crypto";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DomainError, type DomainErrorKind } from "../errors/domain.error";

const KIND_TO_STATUS: Record<DomainErrorKind, number> = {
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  validation: HttpStatus.BAD_REQUEST,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  unprocessable: HttpStatus.UNPROCESSABLE_ENTITY,
  bad_gateway: HttpStatus.BAD_GATEWAY,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
};

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** Maps every thrown error onto the API error contract. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const headerValue = request.headers["x-request-id"];
    const requestId = typeof headerValue === "string" ? headerValue : randomUUID();

    if (exception instanceof DomainError) {
      this.reply(response, KIND_TO_STATUS[exception.kind], {
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      this.reply(response, exception.getStatus(), {
        error: {
          code: "http_error",
          message: exception.message,
          details: exception.getResponse(),
          requestId,
        },
      });
      return;
    }

    // The response deliberately says nothing useful, so the server side must:
    // an internal_error with no log is undebuggable in production.
    this.logger.error(
      `${request.method} ${request.url} failed [${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    this.reply(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      error: { code: "internal_error", message: "internal server error", requestId },
    });
  }

  private reply(response: Response, status: number, body: ErrorBody): void {
    response.status(status).json(body);
  }
}
