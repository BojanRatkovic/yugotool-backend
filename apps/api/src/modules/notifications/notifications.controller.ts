import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { NotificationPage, UnreadCount } from "@zastava/contracts";
import {
  MarkNotificationsReadDto,
  NotificationListQueryDto,
  NotificationPageDto,
  UnreadCountDto,
} from "./notifications.dto";
import { NotificationsService } from "./notifications.service";

@ApiTags("notifications")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /** Newest first, with the unread count; new ones arrive over SSE as `notification`. */
  @Get()
  @ApiOkResponse({ type: NotificationPageDto })
  list(@Query() query: NotificationListQueryDto): Promise<NotificationPage> {
    return this.service.list(query);
  }

  /** `{ ids }` marks those read, `{ all: true }` every unread one. */
  @Post("read")
  @HttpCode(200)
  @ApiOkResponse({ type: UnreadCountDto })
  markRead(@Body() body: MarkNotificationsReadDto): Promise<UnreadCount> {
    return this.service.markRead(body);
  }
}
