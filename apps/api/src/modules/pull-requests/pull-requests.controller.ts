import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { PullRequestList } from "@zastava/contracts";
import { PullRequestListDto, PullRequestListQueryDto } from "./pull-requests.dto";
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
}
