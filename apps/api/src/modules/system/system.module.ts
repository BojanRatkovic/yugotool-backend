import { Module } from "@nestjs/common";
import { ClaudeAccountsModule } from "../claude-accounts/claude-accounts.module";
import { ReposModule } from "../repos/repos.module";
import { DoctorService } from "./doctor.service";
import { PlanUsageService } from "./plan-usage.service";
import { SystemController } from "./system.controller";

@Module({
  imports: [ReposModule, ClaudeAccountsModule],
  controllers: [SystemController],
  providers: [PlanUsageService, DoctorService],
  exports: [PlanUsageService],
})
export class SystemModule {}
