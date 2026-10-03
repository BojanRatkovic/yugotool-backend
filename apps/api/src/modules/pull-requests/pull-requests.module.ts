import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { GithubClient } from "./github/gh-client";
import { PullRequestWritesService } from "./pull-request-writes.service";
import { PullRequestsController } from "./pull-requests.controller";
import { PullRequestsService } from "./pull-requests.service";

/** My pull requests and review requests per project, from GitHub through gh (spec 0008). */
@Module({
  imports: [ProjectsModule],
  controllers: [PullRequestsController],
  providers: [PullRequestsService, PullRequestWritesService, GithubClient],
})
export class PullRequestsModule {}
