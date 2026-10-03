import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  StreamableFile,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type {
  Line,
  PreviewDetection,
  PreviewStatus,
  PreviewTestResult,
  Project,
  ProjectStats,
  RouteMapStatus,
} from "@zastava/contracts";
import {
  CreateProjectDto,
  LineDto,
  PreviewDetectionDto,
  PreviewStatusDto,
  PreviewTestResultDto,
  ProjectDto,
  ProjectStatsDto,
  RouteMapStatusDto,
  UpdateLineDto,
  UpdateProjectDto,
  UpdateRoutesDto,
} from "./projects.dto";
import { ProjectsService } from "./projects.service";

@ApiTags("projects")
@Controller("projects")
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  @ApiOkResponse({ type: [ProjectDto] })
  list(): Promise<Project[]> {
    return this.service.list();
  }

  @Post()
  @ApiCreatedResponse({ type: ProjectDto })
  create(@Body() body: CreateProjectDto): Promise<Project> {
    return this.service.create(body);
  }

  @Put(":id/line")
  @ApiOkResponse({ type: LineDto })
  updateLine(@Param("id", ParseUUIDPipe) id: string, @Body() body: UpdateLineDto): Promise<Line> {
    return this.service.updateLine(id, body);
  }

  @Get(":id/stats")
  @ApiOkResponse({ type: ProjectStatsDto })
  stats(@Param("id", ParseUUIDPipe) id: string): Promise<ProjectStats> {
    return this.service.stats(id);
  }

  @Get(":id/line")
  @ApiOkResponse({ type: LineDto })
  line(@Param("id", ParseUUIDPipe) id: string): Promise<Line> {
    return this.service.getLine(id);
  }

  @Patch(":id")
  @ApiOkResponse({ type: ProjectDto })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: UpdateProjectDto): Promise<Project> {
    return this.service.update(id, body);
  }

  @Post(":id/preview/test")
  @HttpCode(200)
  @ApiOkResponse({ type: PreviewTestResultDto })
  testPreview(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewTestResult> {
    return this.service.testPreview(id);
  }

  @Post(":id/preview/detect")
  @HttpCode(200)
  @ApiOkResponse({ type: PreviewDetectionDto })
  detectPreview(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewDetection> {
    return this.service.detectPreview(id);
  }

  @Get(":id/preview/test")
  @ApiOkResponse({ type: PreviewStatusDto })
  previewStatus(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewStatus> {
    return this.service.previewStatus(id);
  }

  @Get(":id/routes")
  @ApiOkResponse({ type: RouteMapStatusDto })
  routes(@Param("id", ParseUUIDPipe) id: string): Promise<RouteMapStatus> {
    return this.service.routes(id);
  }

  @Post(":id/routes/discover")
  @HttpCode(202)
  @ApiAcceptedResponse({ type: RouteMapStatusDto })
  discoverRoutes(@Param("id", ParseUUIDPipe) id: string): Promise<RouteMapStatus> {
    return this.service.discoverRoutes(id);
  }

  @Put(":id/routes")
  @ApiOkResponse({ type: RouteMapStatusDto })
  updateRoutes(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateRoutesDto,
  ): Promise<RouteMapStatus> {
    return this.service.updateRoutes(id, body);
  }

  @Get(":id/preview/screenshot")
  @ApiProduces("image/png")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "no-cache")
  previewScreenshot(@Param("id", ParseUUIDPipe) id: string): StreamableFile {
    return new StreamableFile(createReadStream(this.service.previewScreenshot(id)));
  }
}
