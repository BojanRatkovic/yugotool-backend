import { Module } from "@nestjs/common";
import { ClaudeAccountsModule } from "../claude-accounts/claude-accounts.module";
import { SystemModule } from "../system/system.module";
import { WorkOrdersModule } from "../work-orders/work-orders.module";
import { DispatcherController } from "./dispatcher.controller";
import { DispatcherService } from "./dispatcher.service";

@Module({
  imports: [SystemModule, WorkOrdersModule, ClaudeAccountsModule],
  controllers: [DispatcherController],
  providers: [DispatcherService],
})
export class DispatcherModule {}
