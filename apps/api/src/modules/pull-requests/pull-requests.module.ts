import { Module } from "@nestjs/common";
import { GithubClient } from "./github/gh-client";

/** My pull requests and review requests per project, from GitHub through gh (spec 0008). */
@Module({
  providers: [GithubClient],
})
export class PullRequestsModule {}
