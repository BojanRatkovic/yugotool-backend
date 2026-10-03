import { Module } from "@nestjs/common";
import { ProjectQueueController, WorkOrdersController } from "./work-orders.controller";
import { WorkOrdersRepository } from "./work-orders.repository";
import { WorkOrdersService } from "./work-orders.service";

@Module({
  controllers: [WorkOrdersController, ProjectQueueController],
  providers: [WorkOrdersService, WorkOrdersRepository],
  exports: [WorkOrdersService, WorkOrdersRepository],
})
export class WorkOrdersModule {}
