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
  postFindingsSchema,
  startReviewSchema,
  zastavaReviewBriefListSchema,
  zastavaReviewQuerySchema,
  zastavaReviewResultSchema,
  zastavaReviewSchema,
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
export class StartReviewDto extends createZodDto(startReviewSchema) {}
export class ZastavaReviewDto extends createZodDto(zastavaReviewSchema) {}
export class ZastavaReviewResultDto extends createZodDto(zastavaReviewResultSchema) {}
export class ZastavaReviewQueryDto extends createZodDto(zastavaReviewQuerySchema) {}
export class PostFindingsDto extends createZodDto(postFindingsSchema) {}
export class ZastavaReviewBriefListDto extends createZodDto(zastavaReviewBriefListSchema) {}
