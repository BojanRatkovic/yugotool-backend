import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { type DispatcherState, dispatcherStateSchema } from "@zastava/contracts";
import { createZodDto } from "nestjs-zod";
import { DispatcherService } from "./dispatcher.service";

class DispatcherStateDto extends createZodDto(dispatcherStateSchema) {}

@ApiTags("dispatcher")
@Controller("dispatcher")
export class DispatcherController {
  constructor(private readonly service: DispatcherService) {}

  @Get()
  @ApiOkResponse({ type: DispatcherStateDto })
  state(): Promise<DispatcherState> {
    return this.service.current();
  }
}
