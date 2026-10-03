import { Module } from "@nestjs/common";
import { PreviewSessionService } from "./preview-session.service";
import { ProjectsController } from "./projects.controller";
import { ProjectsRepository } from "./projects.repository";
import { ProjectsService } from "./projects.service";

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsRepository, PreviewSessionService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
