import {
  connectProductiveSchema,
  importProductiveTasksSchema,
  productiveConnectionSchema,
  productiveProjectQuerySchema,
  productiveProjectSchema,
  productiveStatusSchema,
  productiveTaskPageSchema,
  productiveTaskQuerySchema,
  workOrderSchema,
} from "@yugotool/contracts";
import { createZodDto } from "nestjs-zod";

export class ProductiveConnectionDto extends createZodDto(productiveConnectionSchema) {}
export class ProductiveStatusDto extends createZodDto(productiveStatusSchema) {}
export class ConnectProductiveDto extends createZodDto(connectProductiveSchema) {}
export class ProductiveProjectDto extends createZodDto(productiveProjectSchema) {}
export class ProductiveProjectQueryDto extends createZodDto(productiveProjectQuerySchema) {}
export class ProductiveTaskPageDto extends createZodDto(productiveTaskPageSchema) {}
export class ProductiveTaskQueryDto extends createZodDto(productiveTaskQuerySchema) {}
export class ImportProductiveTasksDto extends createZodDto(importProductiveTasksSchema) {}
export class ImportedWorkOrderDto extends createZodDto(workOrderSchema) {}
