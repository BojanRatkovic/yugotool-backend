import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import {
  type DoctorReport,
  doctorReportSchema,
  type PlanUsage,
  planUsageSchema,
  type SystemInfo,
  systemInfoSchema,
} from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";
import { ReposService } from "../repos/repos.service";
import { SettingsService } from "../settings/settings.service";
import { DoctorService } from "./doctor.service";
import { PlanUsageService } from "./plan-usage.service";

class DoctorReportDto extends createZodDto(doctorReportSchema) {}
class SystemInfoDto extends createZodDto(systemInfoSchema) {}
class PlanUsageDto extends createZodDto(planUsageSchema) {}

@ApiTags("system")
@Controller("system")
export class SystemController {
  constructor(
    private readonly planUsage: PlanUsageService,
    private readonly doctor: DoctorService,
    private readonly repos: ReposService,
    private readonly settings: SettingsService,
  ) {}

  /** First-run checks; each runs fresh (the Claude probe is cached for a minute). */
  @Get("doctor")
  @ApiOkResponse({ type: DoctorReportDto })
  doctorReport(): Promise<DoctorReport> {
    return this.doctor.report();
  }

  @Get("usage")
  @ApiOkResponse({ type: PlanUsageDto })
  usage(): Promise<PlanUsage> {
    return this.planUsage.get();
  }

  /**
   * The worker reads the same key (Settings, else its ANTHROPIC_API_KEY). Each
   * station run also records the source the SDK reported.
   */
  @Get()
  @ApiOkResponse({ type: SystemInfoDto })
  async info(): Promise<SystemInfo> {
    return {
      reposRoot: await this.repos.root(),
      reposRootDefault: this.repos.defaultRoot,
      authSource: (await this.settings.apiKey()) ? "api_key" : "subscription",
    };
  }
}
