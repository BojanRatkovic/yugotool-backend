import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { GithubClient } from "../pull-requests/github/gh-client";
import { CommunityController } from "./community.controller";
import { CommunityService } from "./community.service";

/** GitHub Community Standards checklist per project (spec 0020). */
@Module({
  imports: [ProjectsModule],
  controllers: [CommunityController],
  providers: [CommunityService, GithubClient],
})
export class CommunityModule {}
