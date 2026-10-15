import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { CommunityStandards } from "@yugotool/contracts";
import { CommunityQueryDto, CommunityStandardsDto } from "./community.dto";
import { CommunityService } from "./community.service";

@ApiTags("projects")
@Controller("projects")
export class CommunityController {
  constructor(private readonly service: CommunityService) {}

  /** GitHub's Community Standards checklist for the project's repo (spec 0020). */
  @Get(":id/community-standards")
  @ApiOkResponse({ type: CommunityStandardsDto })
  standards(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: CommunityQueryDto,
  ): Promise<CommunityStandards> {
    return this.service.standards(id, query.repo);
  }
}
