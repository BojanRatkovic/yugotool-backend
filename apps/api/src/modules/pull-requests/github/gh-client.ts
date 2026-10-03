import { execFile } from "node:child_process";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { GhMissingError, GhNotLoggedInError, GithubError } from "../pull-requests.errors";

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 20 * 1024 * 1024;

export interface RestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** e.g. `application/vnd.github.diff` for `restText`. */
  accept?: string;
}

const errorBodySchema = z.object({
  errors: z
    .array(z.object({ message: z.string().optional(), type: z.string().optional() }))
    .optional(),
  message: z.string().optional(),
});

const graphqlEnvelopeSchema = errorBodySchema.extend({ data: z.unknown() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface GhFailure {
  code?: string | number | null | undefined;
  stdout: string;
  stderr: string;
}

/**
 * Turns a failed `gh api` call into a typed error. gh exits non-zero for HTTP
 * errors and GraphQL `errors`; the JSON body (when any) is on stdout. Pure.
 */
export function ghFailureError(failure: GhFailure): Error {
  if (failure.code === "ENOENT") return new GhMissingError();
  const stderr = failure.stderr.trim();
  if (/gh auth login|not logged in|HTTP 401|authentication required/i.test(stderr)) {
    return new GhNotLoggedInError();
  }
  const status = /\(HTTP (\d{3})\)/.exec(stderr);
  const body = githubBody(failure.stdout);
  const httpStatus = status ? Number(status[1]) : body.notFound ? 404 : null;
  const message = body.message ?? (stderr.replace(/^gh: /, "") || "GitHub request failed");
  return new GithubError(message, httpStatus);
}

/** GitHub's error from a JSON body: GraphQL `errors[]` (NOT_FOUND typed) or REST `message`. */
function githubBody(stdout: string): { message: string | null; notFound: boolean } {
  const parsed = errorBodySchema.safeParse(parseJson(stdout));
  if (!parsed.success) return { message: null, notFound: false };
  const body = parsed.data;
  const messages = body.errors?.map((e) => e.message).filter(Boolean) ?? [];
  return {
    message: messages.length ? messages.join("; ") : (body.message ?? null),
    notFound: body.errors?.some((e) => e.type === "NOT_FOUND") ?? false,
  };
}

/**
 * GitHub through the machine's logged-in `gh` (no stored tokens). Requests go
 * over stdin, so comment bodies never appear in process args or logs.
 * Responses are checked against the caller's schema. Swapped for a fake in tests.
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await this.gh(["api", "graphql", "--input", "-"], { query, variables });
    const envelope = graphqlEnvelopeSchema.safeParse(parseJson(stdout));
    if (!envelope.success) throw new GithubError("GitHub returned an unreadable response");
    const { errors, data } = envelope.data;
    if (errors?.length) {
      throw new GithubError(errors.map((e) => e.message ?? "GraphQL error").join("; "));
    }
    return this.check(schema, data);
  }

  /** A REST call answering JSON, checked against `schema`. */
  async rest<T>(path: string, schema: z.ZodType<T>, options: RestOptions = {}): Promise<T> {
    const stdout = await this.gh(this.restArgs(path, options), options.body);
    return this.check(schema, stdout.trim() ? parseJson(stdout) : null);
  }

  /** A REST call answering text (e.g. a diff with `accept: application/vnd.github.diff`). */
  restText(path: string, options: RestOptions = {}): Promise<string> {
    return this.gh(this.restArgs(path, options), options.body);
  }

  private restArgs(path: string, options: RestOptions): string[] {
    const args = ["api", path, "--method", options.method ?? "GET"];
    if (options.accept) args.push("-H", `Accept: ${options.accept}`);
    if (options.body !== undefined) args.push("--input", "-");
    return args;
  }

  private check<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    this.logger.warn(`unexpected GitHub response shape: ${parsed.error.issues[0]?.message}`);
    throw new GithubError("GitHub returned an unexpected response");
  }

  private gh(args: string[], input: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        args,
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const failure = ghFailureError({ code: error.code, stdout, stderr });
          // Args only: bodies travel over stdin and may be private.
          this.logger.warn(`gh ${args.join(" ")} failed: ${failure.message}`);
          reject(failure);
        },
      );
      child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
    });
  }
}
