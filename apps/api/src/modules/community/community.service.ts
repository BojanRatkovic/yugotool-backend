import { Injectable } from "@nestjs/common";
import type { CommunityStandards } from "@yugotool/contracts";
import { z } from "zod";
import { ProjectsService } from "../projects/projects.service";
import { GithubClient } from "../pull-requests/github/gh-client";
import { GithubError } from "../pull-requests/pull-requests.errors";
import { type RepoSlug, repoSlug } from "../pull-requests/github/repo-slug";
import { CommunityUnavailableError } from "./community.errors";
import {
  communityProfileSchema,
  type SecurityPolicy,
  toCommunityStandards,
} from "./github-community";

/** community/profile doesn't report SECURITY.md, so we look in GitHub's three standard spots. */
const SECURITY_PATHS = ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"];

const contentsSchema = z.object({ html_url: z.string().nullable() });

/** GitHub's Community Standards checklist per project, live through gh (spec 0020). */
@Injectable()
export class CommunityService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly github: GithubClient,
  ) {}

  async standards(projectId: string, repo?: string): Promise<CommunityStandards> {
    const slug = await this.repoSlug(projectId, repo);
    const [profile, security] = await Promise.all([
      this.github.rest(
        `/repos/${slug.owner}/${slug.name}/community/profile`,
        communityProfileSchema,
      ),
      this.securityPolicy(slug),
    ]);
    return toCommunityStandards(profile, security, slug);
  }

  /** owner/name of the project's GitHub origin; 422 when the repo isn't on GitHub. */
  private async repoSlug(projectId: string, repo?: string): Promise<RepoSlug> {
    const remote = await this.projects.remote(projectId, repo);
    if (!remote.prPossible) {
      throw new CommunityUnavailableError(
        remote.reason ?? "This repo isn't on GitHub, so there are no community standards to show.",
      );
    }
    const slug = remote.origin ? repoSlug(remote.origin) : null;
    if (!slug) throw new CommunityUnavailableError("origin is not a GitHub repository.");
    return slug;
  }

  private async securityPolicy(slug: RepoSlug): Promise<SecurityPolicy> {
    for (const path of SECURITY_PATHS) {
      const hit = await this.github
        .rest(`/repos/${slug.owner}/${slug.name}/contents/${path}`, contentsSchema)
        .catch((error: unknown) => {
          if (error instanceof GithubError && error.httpStatus === 404) return null;
          throw error;
        });
      if (hit) return { present: true, url: hit.html_url };
    }
    return { present: false, url: null };
  }
}
