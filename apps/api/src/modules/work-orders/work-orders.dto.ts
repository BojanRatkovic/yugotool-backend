import {
  createWorkOrderSchema,
  enqueueSchema,
  listWorkOrdersQuerySchema,
  needsYouItemSchema,
  updateWorkOrderSchema,
  workOrderSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class CreateWorkOrderDto extends createZodDto(createWorkOrderSchema) {}
export class UpdateWorkOrderDto extends createZodDto(updateWorkOrderSchema) {}
export class ListWorkOrdersQueryDto extends createZodDto(listWorkOrdersQuerySchema) {}
export class EnqueueDto extends createZodDto(enqueueSchema) {}
export class NeedsYouItemDto extends createZodDto(needsYouItemSchema) {}
export class WorkOrderDto extends createZodDto(workOrderSchema) {}
