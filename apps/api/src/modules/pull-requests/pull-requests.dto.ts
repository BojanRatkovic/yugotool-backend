import {
  prDiffQuerySchema,
  prDiffSchema,
  pullRequestDetailSchema,
  pullRequestListQuerySchema,
  pullRequestListSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class PullRequestListDto extends createZodDto(pullRequestListSchema) {}
export class PullRequestListQueryDto extends createZodDto(pullRequestListQuerySchema) {}
export class PullRequestDetailDto extends createZodDto(pullRequestDetailSchema) {}
export class PrDiffDto extends createZodDto(prDiffSchema) {}
export class PrDiffQueryDto extends createZodDto(prDiffQuerySchema) {}
