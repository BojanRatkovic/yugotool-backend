import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { ApiAcceptedResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { QaRun, Run, RunDiff, RunEvent, RunMemory, Shift } from "@yugotool/contracts";
import {
  GateDecisionDto,
  RunDiffDto,
  ListRunEventsQueryDto,
  ListRunsQueryDto,
  QaRunDto,
  RunDto,
  RunEventDto,
  RunMemoryDto,
  ShiftDto,
  ShiftReviewDto,
} from "./runs.dto";
import { RunsService } from "./runs.service";

@ApiTags("runs")
@Controller("runs")
export class RunsController {
  constructor(private readonly service: RunsService) {}

  @Get()
  @ApiOkResponse({ type: [RunDto] })
  list(@Query() query: ListRunsQueryDto): Promise<Run[]> {
    return this.service.list(query.workOrderId);
  }

  @Get(":id/events")
  @ApiOkResponse({ type: [RunEventDto] })
  events(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: ListRunEventsQueryDto,
  ): Promise<RunEvent[]> {
    return this.service.listEvents(id, query.afterSeq, query.limit);
  }

  @Get(":id/diff")
  @ApiOkResponse({ type: RunDiffDto })
  diff(@Param("id", ParseUUIDPipe) id: string): Promise<RunDiff> {
    return this.service.diff(id);
  }

  @Post(":id/gates/:stationKey")
  @ApiAcceptedResponse()
  @HttpCode(202)
  decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("stationKey") stationKey: string,
    @Body() body: GateDecisionDto,
  ): Promise<void> {
    return this.service.decideGate(id, stationKey, body);
  }

  @Get(":id/shifts")
  @ApiOkResponse({ type: [ShiftDto] })
  shifts(@Param("id", ParseUUIDPipe) id: string): Promise<Shift[]> {
    return this.service.listShifts(id);
  }

  @Get(":id/memory")
  @ApiOkResponse({ type: RunMemoryDto })
  memory(@Param("id", ParseUUIDPipe) id: string): Promise<RunMemory> {
    return this.service.memory(id);
  }

  @Post(":id/shifts/handoff-now")
  @ApiAcceptedResponse()
  @HttpCode(202)
  handoffNow(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.requestHandoff(id);
  }

  @Post(":id/shifts/stop-after")
  @ApiAcceptedResponse()
  @HttpCode(202)
  stopAfter(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.stopAfterShift(id);
  }

  @Post(":id/shifts/review")
  @ApiAcceptedResponse()
  @HttpCode(202)
  review(@Param("id", ParseUUIDPipe) id: string, @Body() body: ShiftReviewDto): Promise<void> {
    return this.service.reviewShift(id, body);
  }

  @Get(":id/qa")
  @ApiOkResponse({ type: [QaRunDto] })
  qa(@Param("id", ParseUUIDPipe) id: string): Promise<QaRun[]> {
    return this.service.listQa(id);
  }

  @Get(":id/qa/files/*file")
  @ApiProduces("image/png")
  @Header("Content-Type", "image/png")
  // Artifacts never change once written.
  @Header("Cache-Control", "private, max-age=31536000, immutable")
  async qaFile(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("file") file: string | string[],
  ): Promise<StreamableFile> {
    const relative = Array.isArray(file) ? file.join("/") : file;
    return new StreamableFile(createReadStream(await this.service.qaFile(id, relative)));
  }

  @Post(":id/qa/checks/:checkId/accept")
  @ApiAcceptedResponse()
  @HttpCode(202)
  acceptQaCheck(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("checkId", ParseUUIDPipe) checkId: string,
  ): Promise<void> {
    return this.service.acceptQaCheck(id, checkId);
  }
}
