import { communityStandardsSchema, projectRemoteQuerySchema } from "@yugotool/contracts";
import { createZodDto } from "nestjs-zod";

export class CommunityStandardsDto extends createZodDto(communityStandardsSchema) {}

/** `?repo=` selects a hub project's repo (spec 0014); omitted for repo projects. */
export class CommunityQueryDto extends createZodDto(projectRemoteQuerySchema) {}
