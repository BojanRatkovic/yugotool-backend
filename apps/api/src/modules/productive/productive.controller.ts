import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query } from "@nestjs/common";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type {
  ProductiveConnection,
  ProductiveProject,
  ProductiveStatus,
  ProductiveTaskPage,
  WorkOrder,
} from "@yugotool/contracts";
import {
  ConnectProductiveDto,
  ImportedWorkOrderDto,
  ImportProductiveTasksDto,
  ProductiveConnectionDto,
  ProductiveProjectDto,
  ProductiveProjectQueryDto,
  ProductiveStatusDto,
  ProductiveTaskPageDto,
  ProductiveTaskQueryDto,
} from "./productive.dto";
import { ProductiveService } from "./productive.service";

@ApiTags("integrations")
@Controller("integrations/productive")
export class ProductiveController {
  constructor(private readonly productive: ProductiveService) {}

  @Get()
  @ApiOkResponse({ type: ProductiveStatusDto })
  status(): Promise<ProductiveStatus> {
    return this.productive.status();
  }

  /** Connect with a token, or switch organization (no token: the saved one). */
  @Put()
  @ApiOkResponse({ type: ProductiveConnectionDto })
  connect(@Body() body: ConnectProductiveDto): Promise<ProductiveConnection> {
    return this.productive.connect(body);
  }

  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse()
  disconnect(): Promise<void> {
    return this.productive.disconnect();
  }

  @Get("projects")
  @ApiOkResponse({ type: [ProductiveProjectDto] })
  projects(@Query() query: ProductiveProjectQueryDto): Promise<ProductiveProject[]> {
    return this.productive.projects(query);
  }

  @Get("tasks")
  @ApiOkResponse({ type: ProductiveTaskPageDto })
  tasks(@Query() query: ProductiveTaskQueryDto): Promise<ProductiveTaskPage> {
    return this.productive.tasks(query);
  }

  /** Tasks into a project's backlog; already imported ones return their work order. */
  @Post("import")
  @ApiCreatedResponse({ type: [ImportedWorkOrderDto] })
  import(@Body() body: ImportProductiveTasksDto): Promise<WorkOrder[]> {
    return this.productive.import(body);
  }
}
