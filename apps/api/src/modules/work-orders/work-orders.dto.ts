import {
  createWorkOrderSchema,
  enqueueSchema,
  listWorkOrdersQuerySchema,
  needsYouItemSchema,
  openPullRequestResultSchema,
  openPullRequestSchema,
  updateWorkOrderSchema,
  workOrderSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class CreateWorkOrderDto extends createZodDto(createWorkOrderSchema) {}
export class UpdateWorkOrderDto extends createZodDto(updateWorkOrderSchema) {}
export class ListWorkOrdersQueryDto extends createZodDto(listWorkOrdersQuerySchema) {}
export class EnqueueDto extends createZodDto(enqueueSchema) {}
export class NeedsYouItemDto extends createZodDto(needsYouItemSchema) {}
export class OpenPullRequestDto extends createZodDto(openPullRequestSchema) {}
export class OpenPullRequestResultDto extends createZodDto(openPullRequestResultSchema) {}
export class WorkOrderDto extends createZodDto(workOrderSchema) {}
