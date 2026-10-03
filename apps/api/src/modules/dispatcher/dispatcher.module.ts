import { Module } from "@nestjs/common";
import { SystemModule } from "../system/system.module";
import { WorkOrdersModule } from "../work-orders/work-orders.module";
import { DispatcherController } from "./dispatcher.controller";
import { DispatcherService } from "./dispatcher.service";

@Module({
  imports: [SystemModule, WorkOrdersModule],
  controllers: [DispatcherController],
  providers: [DispatcherService],
})
export class DispatcherModule {}
