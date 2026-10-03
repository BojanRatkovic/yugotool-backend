import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { PrDiff, PullRequestDetail, PullRequestList } from "@zastava/contracts";
import {
  PrDiffDto,
  PrDiffQueryDto,
  PullRequestDetailDto,
  PullRequestListDto,
  PullRequestListQueryDto,
} from "./pull-requests.dto";
import { PullRequestsService } from "./pull-requests.service";

@ApiTags("pull-requests")
@Controller("projects/:projectId/pull-requests")
export class PullRequestsController {
  constructor(private readonly service: PullRequestsService) {}

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
}
