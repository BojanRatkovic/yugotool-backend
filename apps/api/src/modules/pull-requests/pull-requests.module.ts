import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { GithubClient } from "./github/gh-client";
import { PullRequestReviewsRepository } from "./pull-request-reviews.repository";
import { PullRequestReviewsService } from "./pull-request-reviews.service";
import { PullRequestWritesService } from "./pull-request-writes.service";
import { PullRequestsController } from "./pull-requests.controller";
import { PullRequestsService } from "./pull-requests.service";
import { ReviewRequestsWatcher } from "./review-requests.watcher";

/** My pull requests and review requests per project, from GitHub through gh (spec 0008). */
@Module({
  imports: [ProjectsModule],
  controllers: [PullRequestsController],
  providers: [
    PullRequestsService,
    PullRequestWritesService,
    PullRequestReviewsService,
    PullRequestReviewsRepository,
    GithubClient,
    ReviewRequestsWatcher,
  ],
})
export class PullRequestsModule {}
