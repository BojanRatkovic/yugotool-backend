import { Module } from "@nestjs/common";
import { NotificationJobsProcessor } from "./notification-jobs.processor";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationsService } from "./notifications.service";

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository, NotificationJobsProcessor],
})
export class NotificationsModule {}
