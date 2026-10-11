import {
  markNotificationsReadSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  unreadCountSchema,
} from "@yugotool/contracts";
import { createZodDto } from "nestjs-zod";

export class NotificationListQueryDto extends createZodDto(notificationListQuerySchema) {}
export class NotificationPageDto extends createZodDto(notificationPageSchema) {}
export class MarkNotificationsReadDto extends createZodDto(markNotificationsReadSchema) {}
export class UnreadCountDto extends createZodDto(unreadCountSchema) {}
