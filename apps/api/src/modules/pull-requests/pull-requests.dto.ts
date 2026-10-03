import {
  prCommentInputSchema,
  prDiffQuerySchema,
  prLineCommentInputSchema,
  prMergeInputSchema,
  prReplyInputSchema,
  prSubmitReviewInputSchema,
  prViewedInputSchema,
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
export class PrCommentInputDto extends createZodDto(prCommentInputSchema) {}
export class PrReplyInputDto extends createZodDto(prReplyInputSchema) {}
export class PrLineCommentInputDto extends createZodDto(prLineCommentInputSchema) {}
export class PrSubmitReviewInputDto extends createZodDto(prSubmitReviewInputSchema) {}
export class PrViewedInputDto extends createZodDto(prViewedInputSchema) {}
export class PrMergeInputDto extends createZodDto(prMergeInputSchema) {}
