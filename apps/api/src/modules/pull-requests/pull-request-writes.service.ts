import { Injectable } from "@nestjs/common";
import type {
  PrLineCommentInput,
  PrMergeMethod,
  PrSubmitReviewInput,
  PrViewedInput,
} from "@zastava/contracts";
import { z } from "zod";
import { GithubClient } from "./github/gh-client";
import {
  ADD_COMMENT,
  ADD_REVIEW,
  ADD_REVIEW_THREAD,
  ADD_THREAD_REPLY,
  UPDATE_REVIEW_BODY,
  DELETE_REVIEW,
  MARK_FILE_VIEWED,
  MARK_READY,
  MERGE_PR,
  PR_WRITE_TARGET,
  RESOLVE_THREAD,
  SUBMIT_REVIEW,
  UNMARK_FILE_VIEWED,
  UNRESOLVE_THREAD,
} from "./github/queries";
import {
  GithubError,
  GithubRefusedError,
  MergeRefusedError,
  PullRequestNotFoundError,
  ReviewBodyRequiredError,
} from "./pull-requests.errors";
import { PullRequestsService } from "./pull-requests.service";

const targetSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        id: z.string(),
        headRefOid: z.string().optional(),
        pendingReviews: z
          .object({
            nodes: z.array(
              z
                .object({
                  id: z.string(),
                  body: z.string().optional(),
                  comments: z.object({ totalCount: z.number().int() }),
                })
                .nullable(),
            ),
          })
          .nullable(),
      })
      .nullable(),
  }),
});
const anySchema = z.unknown();
const addReviewSchema = z.object({
  addPullRequestReview: z.object({ pullRequestReview: z.object({ id: z.string() }) }),
});

/** GraphQL error types that mean "GitHub said no", not "GitHub is broken". */
const REFUSALS = new Set(["UNPROCESSABLE", "FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"]);

interface Target {
  pullRequestId: string;
  headOid: string | null;
  pendingReview: { id: string; body: string; comments: number } | null;
}

/** What went into the pending review: comments by input index, and the first refusal. */
export interface PendingReviewResult {
  added: number[];
  bodyAdded: boolean;
  refused: string | null;
}

/**
 * Writes on a pull request (spec 0008 §5.2). Each one busts the project's
 * cached lists; there is no SSE event (GitHub isn't ours), the client
 * invalidates after its own mutations.
 */
@Injectable()
export class PullRequestWritesService {
  constructor(
    private readonly github: GithubClient,
    private readonly pullRequests: PullRequestsService,
  ) {}

  comment(projectId: string, number: number, body: string): Promise<void> {
    return this.write(projectId, number, async ({ pullRequestId }) => {
      await this.mutate(ADD_COMMENT, { subjectId: pullRequestId, body }, anySchema);
    });
  }

  reply(projectId: string, number: number, threadId: string, body: string): Promise<void> {
    return this.write(projectId, number, async () => {
      await this.mutate(ADD_THREAD_REPLY, { threadId, body }, anySchema);
    });
  }

  resolve(projectId: string, number: number, threadId: string, resolved: boolean): Promise<void> {
    return this.write(projectId, number, async () => {
      await this.mutate(resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId }, anySchema);
    });
  }

  /** A line comment into my pending review, which is created when there is none. */
  lineComment(projectId: string, number: number, input: PrLineCommentInput): Promise<void> {
    return this.write(projectId, number, async (target) => {
      const reviewId = target.pendingReview?.id ?? (await this.startReview(target.pullRequestId));
      await this.mutate(
        ADD_REVIEW_THREAD,
        {
          reviewId,
          path: input.path,
          line: input.line,
          side: input.side,
          startLine: input.startLine ?? null,
          startSide: input.startLine ? (input.startSide ?? input.side) : null,
          body: input.body,
        },
        anySchema,
      );
    });
  }

  /**
   * Line comments plus an addition to the summary, all into my pending review
   * (created when there is none). Never submits. Stops at GitHub's first
   * refusal and says what got in; `expectHead` refuses before writing when the
   * PR moved past the commit the comments were written for.
   */
  async addToPendingReview(
    projectId: string,
    number: number,
    input: { comments: PrLineCommentInput[]; body: string | null; expectHead?: string },
    onHeadMoved: (head: string) => Error,
  ): Promise<PendingReviewResult> {
    const result: PendingReviewResult = { added: [], bodyAdded: false, refused: null };
    await this.write(projectId, number, async (target) => {
      if (input.expectHead && target.headOid && target.headOid !== input.expectHead) {
        throw onHeadMoved(target.headOid);
      }
      let reviewId = target.pendingReview?.id ?? null;
      try {
        if (input.body && target.pendingReview) {
          const current = target.pendingReview.body.trim();
          await this.mutate(
            UPDATE_REVIEW_BODY,
            {
              reviewId: target.pendingReview.id,
              body: current ? `${current}\n\n${input.body}` : input.body,
            },
            anySchema,
          );
          result.bodyAdded = true;
        } else if (input.body) {
          const data = await this.mutate(
            ADD_REVIEW,
            { pullRequestId: target.pullRequestId, body: input.body },
            addReviewSchema,
          );
          reviewId = data.addPullRequestReview.pullRequestReview.id;
          result.bodyAdded = true;
        }
        for (const [index, comment] of input.comments.entries()) {
          reviewId ??= await this.startReview(target.pullRequestId);
          await this.mutate(
            ADD_REVIEW_THREAD,
            {
              reviewId,
              path: comment.path,
              line: comment.line,
              side: comment.side,
              startLine: comment.startLine ?? null,
              startSide: comment.startLine ? (comment.startSide ?? comment.side) : null,
              body: comment.body,
            },
            anySchema,
          );
          result.added.push(index);
        }
      } catch (error) {
        if (!(error instanceof GithubRefusedError)) throw error;
        result.refused = error.message;
      }
    });
    return result;
  }

  /** Submits my pending review, or a new review when there is none. */
  submitReview(projectId: string, number: number, input: PrSubmitReviewInput): Promise<void> {
    return this.write(projectId, number, async ({ pullRequestId, pendingReview }) => {
      const body = input.body.trim();
      if (input.event !== "APPROVE" && !body && !pendingReview?.comments) {
        throw new ReviewBodyRequiredError(
          input.event === "REQUEST_CHANGES"
            ? "Say what needs to change: add a summary or a line comment."
            : "A comment review needs a summary or a line comment.",
        );
      }
      if (pendingReview) {
        await this.mutate(
          SUBMIT_REVIEW,
          { reviewId: pendingReview.id, event: input.event, body },
          anySchema,
        );
      } else {
        await this.mutate(ADD_REVIEW, { pullRequestId, event: input.event, body }, anySchema);
      }
    });
  }

  /** Discards my pending review and its comments; nothing to do when there is none. */
  discardReview(projectId: string, number: number): Promise<void> {
    return this.write(projectId, number, async ({ pendingReview }) => {
      if (pendingReview)
        await this.mutate(DELETE_REVIEW, { reviewId: pendingReview.id }, anySchema);
    });
  }

  setViewed(projectId: string, number: number, input: PrViewedInput): Promise<void> {
    return this.write(projectId, number, async ({ pullRequestId }) => {
      await this.mutate(
        input.viewed ? MARK_FILE_VIEWED : UNMARK_FILE_VIEWED,
        {
          pullRequestId,
          path: input.path,
        },
        anySchema,
      );
    });
  }

  markReady(projectId: string, number: number): Promise<void> {
    return this.write(projectId, number, async ({ pullRequestId }) => {
      await this.mutate(MARK_READY, { pullRequestId }, anySchema);
    });
  }

  merge(projectId: string, number: number, method: PrMergeMethod): Promise<void> {
    return this.write(projectId, number, async ({ pullRequestId }) => {
      try {
        await this.mutate(MERGE_PR, { pullRequestId, method: method.toUpperCase() }, anySchema);
      } catch (error) {
        if (error instanceof GithubRefusedError) throw new MergeRefusedError(error.message);
        throw error;
      }
    });
  }

  private async write(
    projectId: string,
    number: number,
    run: (target: Target) => Promise<void>,
  ): Promise<void> {
    const target = await this.target(projectId, number);
    try {
      await run(target);
    } finally {
      // Even a refused write may have changed something (e.g. a created pending review).
      this.pullRequests.bust(projectId);
    }
  }

  private async target(projectId: string, number: number): Promise<Target> {
    const [repo, viewer] = await Promise.all([
      this.pullRequests.repo(projectId),
      this.pullRequests.viewerLogin(),
    ]);
    const data = await this.github
      .graphql(
        PR_WRITE_TARGET,
        { owner: repo.owner, name: repo.name, number, viewer },
        targetSchema,
      )
      .catch((error: unknown) => {
        if (error instanceof GithubError && error.httpStatus === 404) return null;
        throw error;
      });
    const pr = data?.repository.pullRequest;
    if (!pr) throw new PullRequestNotFoundError(`pull request #${number} not found`);
    const pending = pr.pendingReviews?.nodes.find((n) => n !== null);
    return {
      pullRequestId: pr.id,
      headOid: pr.headRefOid ?? null,
      pendingReview: pending
        ? { id: pending.id, body: pending.body ?? "", comments: pending.comments.totalCount }
        : null,
    };
  }

  private async startReview(pullRequestId: string): Promise<string> {
    const data = await this.mutate(ADD_REVIEW, { pullRequestId }, addReviewSchema);
    return data.addPullRequestReview.pullRequestReview.id;
  }

  /** A mutation; GitHub's refusals (not its outages) become a 422 with GitHub's message. */
  private async mutate<T>(
    document: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return await this.github.graphql(document, variables, schema);
    } catch (error) {
      if (error instanceof GithubError && (REFUSALS.has(error.type ?? "") || isRefusal(error))) {
        throw new GithubRefusedError(error.message);
      }
      throw error;
    }
  }
}

function isRefusal(error: GithubError): boolean {
  return error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500;
}
