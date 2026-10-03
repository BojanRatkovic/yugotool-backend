import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { PrDiff, PullRequestDetail, PullRequestList } from "@zastava/contracts";
import {
  PrCommentInputDto,
  PrDiffDto,
  PrDiffQueryDto,
  PrLineCommentInputDto,
  PrMergeInputDto,
  PrReplyInputDto,
  PrSubmitReviewInputDto,
  PrViewedInputDto,
  PullRequestDetailDto,
  PullRequestListDto,
  PullRequestListQueryDto,
} from "./pull-requests.dto";
import { PullRequestWritesService } from "./pull-request-writes.service";
import { PullRequestsService } from "./pull-requests.service";

@ApiTags("pull-requests")
@Controller("projects/:projectId/pull-requests")
export class PullRequestsController {
  constructor(
    private readonly service: PullRequestsService,
    private readonly writes: PullRequestWritesService,
  ) {}

  /** A board: my PRs, or the ones that want my review (spec 0008 §3). */
  @Get()
  @ApiOkResponse({ type: PullRequestListDto })
  list(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Query() query: PullRequestListQueryDto,
  ): Promise<PullRequestList> {
    return this.service.list(projectId, query.scope, query.teams);
  }

  /** Everything the PR panel shows. */
  @Get(":number")
  @ApiOkResponse({ type: PullRequestDetailDto })
  detail(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
  ): Promise<PullRequestDetail> {
    return this.service.detail(projectId, number);
  }

  /** The unified diff; `since` = only the changes after that commit (409 `since_unknown` if gone). */
  @Get(":number/diff")
  @ApiOkResponse({ type: PrDiffDto })
  diff(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Query() query: PrDiffQueryDto,
  ): Promise<PrDiff> {
    return this.service.diff(projectId, number, query.since);
  }

  // Writes answer 204; the client refetches the detail and the lists.

  /** A comment in the conversation. */
  @Post(":number/comments")
  @HttpCode(204)
  @ApiNoContentResponse()
  comment(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PrCommentInputDto,
  ): Promise<void> {
    return this.writes.comment(projectId, number, body.body);
  }

  @Post(":number/threads/:threadId/replies")
  @HttpCode(204)
  @ApiNoContentResponse()
  reply(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Param("threadId") threadId: string,
    @Body() body: PrReplyInputDto,
  ): Promise<void> {
    return this.writes.reply(projectId, number, threadId, body.body);
  }

  @Post(":number/threads/:threadId/resolve")
  @HttpCode(204)
  @ApiNoContentResponse()
  resolve(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Param("threadId") threadId: string,
  ): Promise<void> {
    return this.writes.resolve(projectId, number, threadId, true);
  }

  @Post(":number/threads/:threadId/unresolve")
  @HttpCode(204)
  @ApiNoContentResponse()
  unresolve(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Param("threadId") threadId: string,
  ): Promise<void> {
    return this.writes.resolve(projectId, number, threadId, false);
  }

  /** A line comment into my pending review (created when there is none). */
  @Post(":number/review/comments")
  @HttpCode(204)
  @ApiNoContentResponse()
  lineComment(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PrLineCommentInputDto,
  ): Promise<void> {
    return this.writes.lineComment(projectId, number, body);
  }

  /** Submits my pending review, or a new one; 422 `review_body_required` per GitHub's rule. */
  @Post(":number/review")
  @HttpCode(204)
  @ApiNoContentResponse()
  submitReview(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PrSubmitReviewInputDto,
  ): Promise<void> {
    return this.writes.submitReview(projectId, number, body);
  }

  /** Discards my pending review. */
  @Delete(":number/review")
  @HttpCode(204)
  @ApiNoContentResponse()
  discardReview(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
  ): Promise<void> {
    return this.writes.discardReview(projectId, number);
  }

  @Put(":number/files/viewed")
  @HttpCode(204)
  @ApiNoContentResponse()
  setViewed(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PrViewedInputDto,
  ): Promise<void> {
    return this.writes.setViewed(projectId, number, body);
  }

  @Post(":number/ready")
  @HttpCode(204)
  @ApiNoContentResponse()
  markReady(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
  ): Promise<void> {
    return this.writes.markReady(projectId, number);
  }

  /** Merges with the method; GitHub's refusal is a 409 `merge_refused` with its message. */
  @Post(":number/merge")
  @HttpCode(204)
  @ApiNoContentResponse()
  merge(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PrMergeInputDto,
  ): Promise<void> {
    return this.writes.merge(projectId, number, body.method);
  }
}
