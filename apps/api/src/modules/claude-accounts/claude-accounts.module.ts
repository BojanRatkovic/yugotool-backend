import { Module } from "@nestjs/common";
import { ClaudeAccountsController } from "./claude-accounts.controller";
import { ClaudeAccountsRepository } from "./claude-accounts.repository";
import { ApiKeyCheck, ClaudeAccountsService } from "./claude-accounts.service";
import { ClaudeCli } from "./claude-cli";
import { ClaudeLoginsService } from "./claude-logins.service";

@Module({
  controllers: [ClaudeAccountsController],
  providers: [
    ClaudeAccountsService,
    ClaudeAccountsRepository,
    ClaudeLoginsService,
    ClaudeCli,
    ApiKeyCheck,
  ],
  exports: [ClaudeAccountsService],
})
export class ClaudeAccountsModule {}
