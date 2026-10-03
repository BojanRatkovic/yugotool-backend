import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
import type { Env } from "../../core/config/env.schema";
import { ReposService } from "../repos/repos.service";
import { DoctorService } from "./doctor.service";
import { PlanUsageService } from "./plan-usage.service";

class DoctorReportDto extends createZodDto(doctorReportSchema) {}
class SystemInfoDto extends createZodDto(systemInfoSchema) {}
class PlanUsageDto extends createZodDto(planUsageSchema) {}

@ApiTags("system")
@Controller("system")
export class SystemController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly planUsage: PlanUsageService,
    private readonly doctor: DoctorService,
    private readonly repos: ReposService,
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
   * The worker shares this machine and shell, so the API's view of the key is
   * the worker's. Each station run also records the source the SDK reported.
   */
  @Get()
  @ApiOkResponse({ type: SystemInfoDto })
  async info(): Promise<SystemInfo> {
    return {
      reposRoot: await this.repos.root(),
      reposRootDefault: this.repos.defaultRoot,
      authSource: this.config.get("ANTHROPIC_API_KEY", { infer: true })
        ? "api_key"
        : "subscription",
    };
  }
}
