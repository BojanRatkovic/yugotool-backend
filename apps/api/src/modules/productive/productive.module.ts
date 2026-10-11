import { Module } from "@nestjs/common";
import { WorkOrdersModule } from "../work-orders/work-orders.module";
import { ProductiveClient } from "./productive.client";
import { ProductiveController } from "./productive.controller";
import { ProductiveRepository } from "./productive.repository";
import { ProductiveService } from "./productive.service";

@Module({
  imports: [WorkOrdersModule],
  controllers: [ProductiveController],
  providers: [ProductiveService, ProductiveRepository, ProductiveClient],
})
export class ProductiveModule {}
