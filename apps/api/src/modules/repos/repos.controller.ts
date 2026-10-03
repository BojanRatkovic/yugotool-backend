import { Controller, Get, Query } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { listBranchesQuerySchema, type Repo, repoSchema } from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";
import { ReposService } from "./repos.service";

class RepoDto extends createZodDto(repoSchema) {}
class ListBranchesQueryDto extends createZodDto(listBranchesQuerySchema) {}

@ApiTags("repos")
@Controller("repos")
export class ReposController {
  constructor(private readonly service: ReposService) {}

  @Get()
  @ApiOkResponse({ type: [RepoDto] })
  list(): Promise<Repo[]> {
    return this.service.list();
  }

  @Get("branches")
  @ApiOkResponse({ type: [String] })
  branches(@Query() query: ListBranchesQueryDto): Promise<string[]> {
    return this.service.branches(query.path);
  }
}
