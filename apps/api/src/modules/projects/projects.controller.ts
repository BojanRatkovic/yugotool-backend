import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type {
  Line,
  PreviewDetection,
  ProjectRemote,
  PreviewSessionStatus,
  PreviewStatus,
  PreviewTestResult,
  Project,
  ProjectStats,
  RouteMapStatus,
} from "@zastava/contracts";
import {
  CreateProjectDto,
  LineDto,
  FinishSignInDto,
  PreviewDetectionDto,
  PreviewSessionStatusDto,
  ProjectRemoteDto,
  PreviewStatusDto,
  PreviewTestResultDto,
  ProjectDto,
  ProjectStatsDto,
  RouteMapStatusDto,
  UpdateLineDto,
  UpdateReviewLineDto,
  UpdateHubRepoDto,
  UpdateProjectDto,
  UpdateRoutesDto,
} from "./projects.dto";
import { PreviewSessionService } from "./preview-session.service";
import { ProjectsService } from "./projects.service";

@ApiTags("projects")
@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly service: ProjectsService,
    private readonly sessions: PreviewSessionService,
  ) {}

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

  @Get(":id/lines/review")
  @ApiOkResponse({ type: LineDto })
  reviewLine(@Param("id", ParseUUIDPipe) id: string): Promise<Line> {
    return this.service.getReviewLine(id);
  }

  @Put(":id/lines/review")
  @ApiOkResponse({ type: LineDto })
  updateReviewLine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateReviewLineDto,
  ): Promise<Line> {
    return this.service.updateReviewLine(id, body);
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

  /** Hub projects: one repo's base branch and preview (spec 0014). */
  @Patch(":id/repos/:repo")
  @ApiOkResponse({ type: ProjectDto })
  updateRepo(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("repo") repo: string,
    @Body() body: UpdateHubRepoDto,
  ): Promise<Project> {
    return this.service.updateHubRepo(id, repo, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  remove(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.delete(id);
  }

  @Post(":id/preview/test")
  @HttpCode(200)
  @ApiOkResponse({ type: PreviewTestResultDto })
  testPreview(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewTestResult> {
    return this.service.testPreview(id);
  }

  /** Where approved work can go (origin, GitHub, gh login); checked live. */
  @Get(":id/remote")
  @ApiOkResponse({ type: ProjectRemoteDto })
  remote(@Param("id", ParseUUIDPipe) id: string): Promise<ProjectRemote> {
    return this.service.remote(id);
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

  /** The saved preview session (if any) and the sign-in in progress (if any). */
  @Get(":id/preview/session")
  @ApiOkResponse({ type: PreviewSessionStatusDto })
  previewSession(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewSessionStatus> {
    return this.sessions.status(id);
  }

  /** Boots the preview and opens a browser window on this Mac to sign in. */
  @Post(":id/preview/sign-in")
  @HttpCode(202)
  @ApiAcceptedResponse({ type: PreviewSessionStatusDto })
  signIn(@Param("id", ParseUUIDPipe) id: string): Promise<PreviewSessionStatus> {
    return this.sessions.start(id);
  }

  @Post(":id/preview/sign-in/finish")
  @HttpCode(202)
  @ApiAcceptedResponse({ type: PreviewSessionStatusDto })
  finishSignIn(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: FinishSignInDto,
  ): Promise<PreviewSessionStatus> {
    return this.sessions.finish(id, body);
  }

  @Delete(":id/preview/session")
  @HttpCode(204)
  @ApiNoContentResponse()
  forgetSession(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.sessions.forget(id);
  }

  @Get(":id/preview/screenshot")
  @ApiProduces("image/png")
  @Header("Content-Type", "image/png")
  @Header("Cache-Control", "no-cache")
  previewScreenshot(@Param("id", ParseUUIDPipe) id: string): StreamableFile {
    return new StreamableFile(createReadStream(this.service.previewScreenshot(id)));
  }
}
