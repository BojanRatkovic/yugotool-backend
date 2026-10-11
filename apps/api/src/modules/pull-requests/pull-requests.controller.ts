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
import type {
  PrDiff,
  PullRequestDetail,
  PullRequestList,
  YugoToolReview,
  YugoToolReviewBriefList,
  YugoToolReviewResult,
} from "@yugotool/contracts";
import {
  PostFindingsDto,
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
  StartReviewDto,
  YugoToolReviewBriefListDto,
  YugoToolReviewDto,
  YugoToolReviewQueryDto,
  YugoToolReviewResultDto,
} from "./pull-requests.dto";
import { PullRequestReviewsService } from "./pull-request-reviews.service";
import { PullRequestWritesService } from "./pull-request-writes.service";
import { PullRequestsService } from "./pull-requests.service";

@ApiTags("pull-requests")
@Controller("projects/:projectId/pull-requests")
export class PullRequestsController {
  constructor(
    private readonly service: PullRequestsService,
    private readonly writes: PullRequestWritesService,
    private readonly reviews: PullRequestReviewsService,
  ) {}

  /** The latest YugoTool review of the PR (spec 0009); `head` = its current head, for `stale`. */
  @Get(":number/yugotool-review")
  @ApiOkResponse({ type: YugoToolReviewResultDto })
  async yugotoolReview(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Query() query: YugoToolReviewQueryDto,
  ): Promise<YugoToolReviewResult> {
    return { review: await this.reviews.latest(projectId, number, query.head) };
  }

  /**
   * The kept findings (as edited) into my pending review; never submits.
   * 422 `review_stale` when the PR moved past the reviewed commit.
   */
  @Post(":number/yugotool-review/post")
  @HttpCode(200)
  @ApiOkResponse({ type: YugoToolReviewDto })
  postYugoToolFindings(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: PostFindingsDto,
  ): Promise<YugoToolReview> {
    return this.reviews.post(projectId, number, body);
  }

  /** Starts a YugoTool review on the PR's current head; 409 `review_running` while one runs. */
  @Post(":number/yugotool-review")
  @ApiOkResponse({ type: YugoToolReviewDto })
  startYugoToolReview(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Param("number", ParseIntPipe) number: number,
    @Body() body: StartReviewDto,
  ): Promise<YugoToolReview> {
    return this.reviews.start(projectId, number, body);
  }

  /** A board: my PRs, or the ones that want my review (spec 0008 §3). */
  @Get()
  @ApiOkResponse({ type: PullRequestListDto })
  list(
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Query() query: PullRequestListQueryDto,
  ): Promise<PullRequestList> {
    return this.service.list(projectId, query.scope, query.teams);
  }

  /** Every PR's latest YugoTool review, for the cards (spec 0009). Before `:number`. */
  @Get("yugotool-reviews")
  @ApiOkResponse({ type: YugoToolReviewBriefListDto })
  async yugotoolReviews(
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ): Promise<YugoToolReviewBriefList> {
    return { items: await this.reviews.briefs(projectId) };
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
