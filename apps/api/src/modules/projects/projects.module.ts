import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller";
import { ProjectsRepository } from "./projects.repository";
import { ProjectsService } from "./projects.service";

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsRepository],
  exports: [ProjectsService],
})
export class ProjectsModule {}
