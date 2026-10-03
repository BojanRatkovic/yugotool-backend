import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { NeedsYouItem, WorkOrder } from "@zastava/contracts";
import {
  CreateWorkOrderDto,
  EnqueueDto,
  ListWorkOrdersQueryDto,
  NeedsYouItemDto,
  UpdateWorkOrderDto,
  WorkOrderDto,
} from "./work-orders.dto";
import { WorkOrdersService } from "./work-orders.service";

@ApiTags("work-orders")
@Controller("work-orders")
export class WorkOrdersController {
  constructor(private readonly service: WorkOrdersService) {}

  @Get()
  @ApiOkResponse({ type: [WorkOrderDto] })
  list(@Query() query: ListWorkOrdersQueryDto): Promise<WorkOrder[]> {
    return this.service.list(query.projectId);
  }

  /** Declared before `:id` routes so "needs-you" is never parsed as an id. */
  @Get("needs-you")
  @ApiOkResponse({ type: [NeedsYouItemDto] })
  needsYou(): Promise<NeedsYouItem[]> {
    return this.service.needsYou();
  }

  @Post()
  @ApiCreatedResponse({ type: WorkOrderDto })
  create(@Body() body: CreateWorkOrderDto): Promise<WorkOrder> {
    return this.service.create(body);
  }

  @Patch(":id")
  @ApiOkResponse({ type: WorkOrderDto })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkOrderDto,
  ): Promise<WorkOrder> {
    return this.service.update(id, body);
  }

  @Post(":id/start")
  @ApiOkResponse({ type: WorkOrderDto })
  @HttpCode(200)
  start(@Param("id", ParseUUIDPipe) id: string): Promise<WorkOrder> {
    return this.service.start(id);
  }

  @Post(":id/enqueue")
  @ApiOkResponse({ type: WorkOrderDto })
  @HttpCode(200)
  enqueue(@Param("id", ParseUUIDPipe) id: string, @Body() body: EnqueueDto): Promise<WorkOrder> {
    return this.service.enqueue(id, body.mode);
  }

  @Post(":id/dequeue")
  @ApiOkResponse({ type: WorkOrderDto })
  @HttpCode(200)
  dequeue(@Param("id", ParseUUIDPipe) id: string): Promise<WorkOrder> {
    return this.service.dequeue(id);
  }

  @Post(":id/open-editor")
  @ApiNoContentResponse()
  @HttpCode(204)
  openEditor(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.openInEditor(id);
  }

  @Post(":id/cancel")
  @ApiNoContentResponse()
  @HttpCode(204)
  cancel(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.cancel(id);
  }
}

@ApiTags("work-orders")
@Controller("projects")
export class ProjectQueueController {
  constructor(private readonly service: WorkOrdersService) {}

  @Post(":id/run-backlog")
  @HttpCode(200)
  runBacklog(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: EnqueueDto,
  ): Promise<{ queued: number }> {
    return this.service.enqueueBacklog(id, body.mode);
  }
}
