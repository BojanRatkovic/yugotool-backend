import { Body, Controller, Get, HttpCode, Patch, Post } from "@nestjs/common";
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import {
  notificationTestSchema,
  type Settings,
  settingsSchema,
  updateSettingsSchema,
} from "@zastava/contracts";
import { ChannelNotConfiguredError } from "@zastava/notify";
import { createZodDto } from "nestjs-zod";
import { DomainError } from "../../common/errors/domain.error";
import { SettingsService } from "./settings.service";

class SettingsDto extends createZodDto(settingsSchema) {}
class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
class NotificationTestDto extends createZodDto(notificationTestSchema) {}

class NotificationFailedError extends DomainError {
  readonly code = "notification_failed";
  readonly kind = "validation";
}

@ApiTags("settings")
@Controller("settings")
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @ApiOkResponse({ type: SettingsDto })
  get(): Promise<Settings> {
    return this.service.get();
  }

  @Patch()
  @ApiOkResponse({ type: SettingsDto })
  update(@Body() body: UpdateSettingsDto): Promise<Settings> {
    return this.service.update(body);
  }

  /** Surfaces the channel's own error (bad webhook, wrong chat id) to the settings form. */
  @Post("notifications/test")
  @ApiNoContentResponse()
  @HttpCode(204)
  async test(@Body() body: NotificationTestDto): Promise<void> {
    try {
      await this.service.sendTest(body.channel);
    } catch (error) {
      if (error instanceof ChannelNotConfiguredError)
        throw new NotificationFailedError(error.message);
      throw new NotificationFailedError(
        `${body.channel} rejected the message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
