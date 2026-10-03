import {
  gateDecisionSchema,
  listRunEventsQuerySchema,
  listRunsQuerySchema,
  qaRunSchema,
  runEventSchema,
  runDiffSchema,
  runMemorySchema,
  runSchema,
  shiftReviewSchema,
  shiftSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class ListRunsQueryDto extends createZodDto(listRunsQuerySchema) {}
export class ListRunEventsQueryDto extends createZodDto(listRunEventsQuerySchema) {}
export class GateDecisionDto extends createZodDto(gateDecisionSchema) {}
export class RunDiffDto extends createZodDto(runDiffSchema) {}
export class RunDto extends createZodDto(runSchema) {}
export class RunEventDto extends createZodDto(runEventSchema) {}
export class ShiftDto extends createZodDto(shiftSchema) {}
export class RunMemoryDto extends createZodDto(runMemorySchema) {}
export class ShiftReviewDto extends createZodDto(shiftReviewSchema) {}
export class QaRunDto extends createZodDto(qaRunSchema) {}
