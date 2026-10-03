import { Injectable } from "@nestjs/common";
import type { PrScope, PullRequestList, PullRequestSummary } from "@zastava/contracts";
import { z } from "zod";
import { ProjectsService } from "../projects/projects.service";
import { GithubClient } from "./github/gh-client";
import { SEARCH_PRS, VIEWER } from "./github/queries";
import { type RepoSlug, repoSlug } from "./github/repo-slug";
import {
  type GhPullRequest,
  ghSearchSchema,
  searchPullRequests,
  toSummary,
} from "./pull-requests.mapper";
import { PullRequestsUnavailableError } from "./pull-requests.errors";

const REPO_TTL_MS = 5 * 60_000;
const LIST_TTL_MS = 20_000;
/** Done columns look back this far. */
const DONE_DAYS = 14;

const viewerSchema = z.object({ viewer: z.object({ login: z.string() }) });
const searchSchema = z.object({ search: ghSearchSchema });

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/** Pull request boards per project, straight from GitHub (no DB). Spec 0008 §5. */
@Injectable()
export class PullRequestsService {
  private viewer: Promise<string> | null = null;
  private readonly repos = new Map<string, Cached<RepoSlug>>();
  private readonly lists = new Map<string, Cached<Promise<PullRequestList>>>();

  constructor(
    private readonly github: GithubClient,
    private readonly projects: ProjectsService,
  ) {}

  /** The board's pull requests; cached 20 s so the sidebar counts and the board share one call. */
  list(projectId: string, scope: PrScope, teams: boolean): Promise<PullRequestList> {
    const key = `${projectId}:${scope}:${scope === "assigned" && teams}`;
    const hit = this.lists.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = this.fetchList(projectId, scope, teams);
    this.lists.set(key, { value, expiresAt: Date.now() + LIST_TTL_MS });
    // A failure isn't cached: the next request tries again.
    value.catch(() => this.lists.delete(key));
    return value;
  }

  /** Forget a project's cached lists (after a write). */
  bust(projectId: string): void {
    for (const key of this.lists.keys()) {
      if (key.startsWith(`${projectId}:`)) this.lists.delete(key);
    }
  }

  private async fetchList(
    projectId: string,
    scope: PrScope,
    teams: boolean,
  ): Promise<PullRequestList> {
    const [repo, viewer] = await Promise.all([this.repo(projectId), this.viewerLogin()]);
    const slug = `${repo.owner}/${repo.name}`;
    const since = new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const base = `repo:${slug} is:pr sort:updated-desc`;
    const items =
      scope === "mine"
        ? await this.mine(base, since, viewer)
        : await this.assigned(base, since, viewer, teams);
    return {
      repo: slug,
      viewer,
      items: items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async mine(base: string, since: string, viewer: string): Promise<PullRequestSummary[]> {
    const [open, done] = await Promise.all([
      this.search(`${base} is:open author:@me`, viewer),
      this.search(`${base} is:closed author:@me closed:>=${since}`, viewer),
    ]);
    return [...open, ...done].map((pr) => toSummary(pr, { viewer }));
  }

  private async assigned(
    base: string,
    since: string,
    viewer: string,
    teams: boolean,
  ): Promise<PullRequestSummary[]> {
    const open = `${base} is:open -author:@me`;
    const [requested, assigned, reviewed, reviewedDone, team] = await Promise.all([
      this.search(`${open} user-review-requested:@me`, viewer),
      this.search(`${open} assignee:@me`, viewer),
      this.search(`${open} reviewed-by:@me`, viewer),
      this.search(`${base} is:closed -author:@me reviewed-by:@me closed:>=${since}`, viewer),
      teams ? this.search(`${open} review-requested:@me`, viewer) : Promise.resolve([]),
    ]);
    const teamNumbers = new Set(team.map((pr) => pr.number));
    const byNumber = new Map<number, PullRequestSummary>();
    for (const pr of [...requested, ...assigned, ...reviewed, ...reviewedDone, ...team]) {
      if (byNumber.has(pr.number)) continue;
      byNumber.set(pr.number, toSummary(pr, { viewer, teamRequested: teamNumbers.has(pr.number) }));
    }
    return [...byNumber.values()];
  }

  private async search(query: string, viewer: string): Promise<GhPullRequest[]> {
    const data = await this.github.graphql(SEARCH_PRS, { viewer, query }, searchSchema);
    return searchPullRequests(data.search);
  }

  /** owner/name of the project's GitHub origin; 422 when the project can't use PRs. */
  async repo(projectId: string): Promise<RepoSlug> {
    const hit = this.repos.get(projectId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const remote = await this.projects.remote(projectId);
    if (!remote.prPossible) {
      throw new PullRequestsUnavailableError(remote.reason ?? "Pull requests aren't available.");
    }
    const slug = remote.origin ? repoSlug(remote.origin) : null;
    if (!slug) throw new PullRequestsUnavailableError("origin is not a GitHub repository.");
    this.repos.set(projectId, { value: slug, expiresAt: Date.now() + REPO_TTL_MS });
    return slug;
  }

  /** The gh user's login, asked once per API process. */
  viewerLogin(): Promise<string> {
    this.viewer ??= this.github.graphql(VIEWER, {}, viewerSchema).then(
      (data) => data.viewer.login,
      (error: unknown) => {
        this.viewer = null;
        throw error;
      },
    );
    return this.viewer;
  }
}
