import {
  claudeAccountLoginCodeSchema,
  claudeAccountLoginSchema,
  claudeAccountSchema,
  createClaudeAccountSchema,
  discoveredAccountSchema,
  setDefaultClaudeAccountSchema,
  startClaudeLoginSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";

export class ClaudeAccountDto extends createZodDto(claudeAccountSchema) {}
export class CreateClaudeAccountDto extends createZodDto(createClaudeAccountSchema) {}
export class DiscoveredAccountDto extends createZodDto(discoveredAccountSchema) {}
export class SetDefaultClaudeAccountDto extends createZodDto(setDefaultClaudeAccountSchema) {}
export class StartClaudeLoginDto extends createZodDto(startClaudeLoginSchema) {}
export class ClaudeAccountLoginDto extends createZodDto(claudeAccountLoginSchema) {}
export class ClaudeAccountLoginCodeDto extends createZodDto(claudeAccountLoginCodeSchema) {}
