import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import {
  type AccountPlanUsage,
  accountPlanUsageSchema,
  type DoctorReport,
  doctorReportSchema,
  type PlanUsage,
  planUsageSchema,
  type SystemInfo,
  systemInfoSchema,
} from "@yugotool/contracts";
import { createZodDto } from "nestjs-zod";
import { ClaudeAccountsService } from "../claude-accounts/claude-accounts.service";
import { ReposService } from "../repos/repos.service";
import { DoctorService } from "./doctor.service";
import { PlanUsageService } from "./plan-usage.service";

class DoctorReportDto extends createZodDto(doctorReportSchema) {}
class SystemInfoDto extends createZodDto(systemInfoSchema) {}
class PlanUsageDto extends createZodDto(planUsageSchema) {}
class AccountPlanUsageDto extends createZodDto(accountPlanUsageSchema) {}

@ApiTags("system")
@Controller("system")
export class SystemController {
  constructor(
    private readonly planUsage: PlanUsageService,
    private readonly doctor: DoctorService,
    private readonly repos: ReposService,
    private readonly accounts: ClaudeAccountsService,
  ) {}

  /** First-run checks; each runs fresh (the Claude probe is cached for a minute). */
  @Get("doctor")
  @ApiOkResponse({ type: DoctorReportDto })
  doctorReport(): Promise<DoctorReport> {
    return this.doctor.report();
  }

  /** The plan of the account projects get by default (spec 0016). */
  @Get("usage")
  @ApiOkResponse({ type: PlanUsageDto })
  async usage(): Promise<PlanUsage> {
    return this.planUsage.get(await this.accounts.authFor(null));
  }

  /** Every account's plan, for the meter's popover; API keys come back unavailable. */
  @Get("usage/accounts")
  @ApiOkResponse({ type: [AccountPlanUsageDto] })
  async usageByAccount(): Promise<AccountPlanUsage[]> {
    const targets = await this.accounts.usageTargets();
    return Promise.all(
      targets.map(async (auth) => ({
        accountId: auth.accountId,
        label: auth.label,
        usage: await this.planUsage.get(auth),
      })),
    );
  }

  /**
   * What projects without their own account run on: the default account, else
   * the worker's environment (Settings key, else ANTHROPIC_API_KEY, else its
   * login). Each station run also records the source the SDK reported.
   */
  @Get()
  @ApiOkResponse({ type: SystemInfoDto })
  async info(): Promise<SystemInfo> {
    return {
      reposRoot: await this.repos.root(),
      reposRootDefault: this.repos.defaultRoot,
      authSource: (await this.accounts.authFor(null)).billsPlan ? "subscription" : "api_key",
      claudeLogin: await this.accounts.machineLogin(),
    };
  }
}
