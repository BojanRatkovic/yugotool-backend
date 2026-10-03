import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

@ApiTags("health")
@Controller("health")
export class HealthController {
  /** `pid` lets the desktop supervisor tell its own API from another server on the port. */
  @Get()
  check(): { status: "ok"; pid: number } {
    return { status: "ok", pid: process.pid };
  }
}
