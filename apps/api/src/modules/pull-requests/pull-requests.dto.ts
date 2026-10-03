import { pullRequestListQuerySchema, pullRequestListSchema } from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class PullRequestListDto extends createZodDto(pullRequestListSchema) {}
export class PullRequestListQueryDto extends createZodDto(pullRequestListQuerySchema) {}
