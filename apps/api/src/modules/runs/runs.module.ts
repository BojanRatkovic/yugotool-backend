import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunsRepository } from "./runs.repository";
import { RunsService } from "./runs.service";

@Module({
  controllers: [RunsController],
  providers: [RunsService, RunsRepository],
})
export class RunsModule {}
