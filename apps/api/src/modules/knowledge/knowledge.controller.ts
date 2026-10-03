import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { KnowledgeSource, ProjectKnowledge } from "@zastava/contracts";
import {
  CreateKnowledgeSourceDto,
  KnowledgeSourceDto,
  ProjectKnowledgeDto,
  UpdateKnowledgeSourceDto,
} from "./knowledge.dto";
import { KnowledgeService } from "./knowledge.service";

@ApiTags("knowledge")
@Controller("knowledge-sources")
export class KnowledgeSourcesController {
  constructor(private readonly service: KnowledgeService) {}

  @Get()
  @ApiOkResponse({ type: [KnowledgeSourceDto] })
  list(): Promise<KnowledgeSource[]> {
    return this.service.list();
  }

  /** Adds a source and syncs it once; a failed sync comes back as `lastError`. */
  @Post()
  @ApiCreatedResponse({ type: KnowledgeSourceDto })
  create(@Body() body: CreateKnowledgeSourceDto): Promise<KnowledgeSource> {
    return this.service.create(body);
  }

  @Patch(":id")
  @ApiOkResponse({ type: KnowledgeSourceDto })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateKnowledgeSourceDto,
  ): Promise<KnowledgeSource> {
    return this.service.update(id, body);
  }

  @Delete(":id")
  @ApiNoContentResponse()
  @HttpCode(204)
  delete(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.delete(id);
  }

  @Post(":id/sync")
  @HttpCode(200)
  @ApiOkResponse({ type: KnowledgeSourceDto })
  sync(@Param("id", ParseUUIDPipe) id: string): Promise<KnowledgeSource> {
    return this.service.sync(id);
  }
}

@ApiTags("knowledge")
@Controller("projects")
export class ProjectKnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Get(":id/knowledge")
  @ApiOkResponse({ type: ProjectKnowledgeDto })
  get(@Param("id", ParseUUIDPipe) id: string): Promise<ProjectKnowledge> {
    return this.service.projectKnowledge(id);
  }

  @Put(":id/knowledge")
  @ApiOkResponse({ type: ProjectKnowledgeDto })
  set(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ProjectKnowledgeDto,
  ): Promise<ProjectKnowledge> {
    return this.service.setProjectKnowledge(id, body);
  }
}
