import { Injectable } from "@nestjs/common";
import type {
  PrDiff,
  PrScope,
  PullRequestDetail,
  PullRequestList,
  PullRequestSummary,
} from "@zastava/contracts";
import { z } from "zod";
import { ProjectsService } from "../projects/projects.service";
import { GithubClient } from "./github/gh-client";
import {
  PR_DETAIL,
  PR_FILES,
  PR_FINGERPRINT,
  PR_THREADS,
  PR_TIMELINE,
  PRS_BY_ID,
  SEARCH_FINGERPRINTS,
  VIEWER,
} from "./github/queries";
import { type RepoSlug, repoSlug } from "./github/repo-slug";
import {
  type GhFiles,
  type GhFingerprint,
  type GhPullRequest,
  type GhTimeline,
  type GhTimelineNode,
  fingerprintKey,
  fingerprints,
  ghDetailSchema,
  ghFilesSchema,
  ghFingerprintSearchSchema,
  ghNodesSchema,
  ghThreadsSchema,
  ghTimelineSchema,
  pullRequestNodes,
  toDetail,
  toSummary,
} from "./pull-requests.mapper";
import {
  GithubError,
  GithubRateLimitedError,
  isRateLimit,
  PullRequestNotFoundError,
  PullRequestsUnavailableError,
  SinceUnknownError,
} from "./pull-requests.errors";
import { capPatch, onlyPrFiles } from "./pull-requests.diff";

const REPO_TTL_MS = 5 * 60_000;
const LIST_TTL_MS = 20_000;
/** Full fields are refetched when a PR's fingerprint moves, and at least this often. */
const PR_TTL_MS = 30 * 60_000;
/** An open panel is rebuilt when its fingerprint moves, and at least this often. */
const DETAIL_TTL_MS = 10 * 60_000;
/** PRS_BY_ID batch size: its cost grows with the count. */
const HYDRATE_BATCH = 25;
/** Done columns look back this far. */
const DONE_DAYS = 14;

const viewerSchema = z.object({ viewer: z.object({ login: z.string() }) });
const fingerprintSchema = z.object({
  repository: z.object({
    pullRequest: z.unknown(),
  }),
});
const pullRefsSchema = z.object({
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
});
const DIFF = "application/vnd.github.diff";
/** Caps from spec 0008 §4: GitHub has the rest. */
const MAX_FILE_PAGES = 3;
const MAX_TIMELINE_ITEMS = 250;

interface Cached<T> {
  value: T;
  expiresAt: number;
}

interface CachedPr {
  key: string;
  pr: GhPullRequest;
  fetchedAt: number;
}

interface CachedDetail {
  key: string;
  detail: PullRequestDetail;
  fetchedAt: number;
}

/** Pull request boards per project, straight from GitHub (no DB). Spec 0008 §5. */
@Injectable()
export class PullRequestsService {
  private viewer: Promise<string> | null = null;
  private readonly repos = new Map<string, Cached<RepoSlug>>();
  private readonly lists = new Map<string, Cached<Promise<PullRequestList>>>();
  /** The last list that loaded, served when GitHub refuses (rate limit, outage). */
  private readonly lastLists = new Map<string, PullRequestList>();
  /** Full card fields per PR node id, keyed by fingerprint. */
  private readonly prs = new Map<string, CachedPr>();
  private readonly details = new Map<string, CachedDetail>();

  constructor(
    private readonly github: GithubClient,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * The board's pull requests; cached 20 s so the sidebar counts and the board
   * share one call. When GitHub refuses, the last good list is served (its
   * `fetchedAt` tells the UI how old it is).
   */
  list(projectId: string, scope: PrScope, teams: boolean): Promise<PullRequestList> {
    const key = `${projectId}:${scope}:${scope === "assigned" && teams}`;
    const hit = this.lists.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = this.fetchList(projectId, scope, teams).then(
      (list) => {
        this.lastLists.set(key, list);
        return list;
      },
      (error: unknown) => {
        this.lists.delete(key);
        const last = this.lastLists.get(key);
        if (last && error instanceof GithubError) return last;
        throw rateLimited(error);
      },
    );
    this.lists.set(key, { value, expiresAt: Date.now() + LIST_TTL_MS });
    return value;
  }

  /** Forget a project's cached lists and panels (after a write). */
  bust(projectId: string): void {
    for (const key of [...this.lists.keys(), ...this.details.keys()]) {
      if (key.startsWith(`${projectId}:`)) {
        this.lists.delete(key);
        this.details.delete(key);
      }
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
      this.search(`${base} is:open author:@me`),
      this.search(`${base} is:closed author:@me closed:>=${since}`),
    ]);
    const prs = await this.hydrate([...open, ...done], viewer);
    return prs.map((pr) => toSummary(pr, { viewer }));
  }

  private async assigned(
    base: string,
    since: string,
    viewer: string,
    teams: boolean,
  ): Promise<PullRequestSummary[]> {
    const open = `${base} is:open -author:@me`;
    const [requested, assigned, reviewed, reviewedDone, team] = await Promise.all([
      this.search(`${open} user-review-requested:@me`),
      this.search(`${open} assignee:@me`),
      this.search(`${open} reviewed-by:@me`),
      this.search(`${base} is:closed -author:@me reviewed-by:@me closed:>=${since}`),
      teams ? this.search(`${open} review-requested:@me`) : Promise.resolve([]),
    ]);
    const teamNumbers = new Set(team.map((pr) => pr.number));
    const prs = await this.hydrate(
      [...requested, ...assigned, ...reviewed, ...reviewedDone, ...team],
      viewer,
    );
    return prs.map((pr) => toSummary(pr, { viewer, teamRequested: teamNumbers.has(pr.number) }));
  }

  /** A cheap search: just enough to tell which PRs changed. */
  private async search(query: string): Promise<GhFingerprint[]> {
    return fingerprints(
      await this.github.graphql(SEARCH_FINGERPRINTS, { query }, ghFingerprintSearchSchema),
    );
  }

  /**
   * Full card fields for the found PRs (deduped, in order): from the cache
   * when the fingerprint still matches, else in batches from GitHub.
   */
  private async hydrate(found: GhFingerprint[], viewer: string): Promise<GhPullRequest[]> {
    const unique = [...new Map(found.map((f) => [f.id, f])).values()];
    const now = Date.now();
    const stale = unique.filter((f) => {
      const cached = this.prs.get(f.id);
      return !cached || cached.key !== fingerprintKey(f) || now - cached.fetchedAt > PR_TTL_MS;
    });
    for (let i = 0; i < stale.length; i += HYDRATE_BATCH) {
      const batch = stale.slice(i, i + HYDRATE_BATCH);
      const data = await this.github.graphql(
        PRS_BY_ID,
        { ids: batch.map((f) => f.id), viewer },
        ghNodesSchema,
      );
      const byId = new Map(pullRequestNodes(data).map((pr) => [pr.id, pr]));
      for (const f of batch) {
        const pr = byId.get(f.id);
        if (pr) this.prs.set(f.id, { key: fingerprintKey(f), pr, fetchedAt: now });
      }
    }
    return unique.flatMap((f) => {
      const cached = this.prs.get(f.id);
      return cached ? [cached.pr] : [];
    });
  }

  /**
   * Everything the PR panel shows. A cheap fingerprint first: when nothing
   * moved, the cached panel is returned (an open panel polls every 30 s).
   */
  async detail(projectId: string, number: number): Promise<PullRequestDetail> {
    const [repo, viewer] = await Promise.all([this.repo(projectId), this.viewerLogin()]);
    const vars = { owner: repo.owner, name: repo.name, number };
    const cacheKey = `${projectId}:${number}`;
    const cached = this.details.get(cacheKey);
    try {
      const fingerprint = await this.github.graphql(PR_FINGERPRINT, vars, fingerprintSchema);
      if (fingerprint.repository.pullRequest === null) {
        throw new PullRequestNotFoundError(`pull request #${number} not found`);
      }
      const key = JSON.stringify(fingerprint.repository.pullRequest);
      if (cached && cached.key === key && Date.now() - cached.fetchedAt < DETAIL_TTL_MS) {
        return cached.detail;
      }
      const detail = await this.fetchDetail(vars, viewer);
      this.details.set(cacheKey, { key, detail, fetchedAt: Date.now() });
      return detail;
    } catch (error) {
      if (error instanceof GithubError && error.httpStatus === 404) {
        throw new PullRequestNotFoundError(`pull request #${number} not found`);
      }
      if (cached && error instanceof GithubError) return cached.detail;
      throw rateLimited(error);
    }
  }

  /** The full panel, in four parallel requests (one big one times out). */
  private async fetchDetail(
    vars: { owner: string; name: string; number: number },
    viewer: string,
  ): Promise<PullRequestDetail> {
    const [detail, threads, files, timeline] = await Promise.all([
      this.github.graphql(PR_DETAIL, { ...vars, viewer }, ghDetailSchema),
      this.github.graphql(PR_THREADS, vars, ghThreadsSchema),
      this.files(vars),
      this.timeline(vars),
    ]);
    const pr = detail.repository.pullRequest;
    const reviewThreads = threads.repository.pullRequest?.reviewThreads;
    if (!pr) throw new PullRequestNotFoundError(`pull request #${vars.number} not found`);
    return toDetail(
      {
        detail: detail.repository,
        pr,
        threads: (reviewThreads?.nodes ?? []).filter((t) => t !== null),
        threadsTotal: reviewThreads?.totalCount ?? 0,
        ...files,
        ...timeline,
      },
      viewer,
    );
  }

  /**
   * The PR's unified diff, or with `since` only what changed after that commit
   * (my last review). GitHub refuses diffs over its own limits (406): then the
   * patch is empty and truncated, and the UI links to GitHub.
   */
  async diff(projectId: string, number: number, since?: string): Promise<PrDiff> {
    const repo = await this.repo(projectId);
    const base = `repos/${repo.owner}/${repo.name}`;
    const refs = await this.github
      .rest(`${base}/pulls/${number}`, pullRefsSchema)
      .catch((error: unknown) => {
        if (error instanceof GithubError && error.httpStatus === 404) {
          throw new PullRequestNotFoundError(`pull request #${number} not found`);
        }
        throw error;
      });
    const head = refs.head.sha;
    const from = since ?? refs.base.sha;
    try {
      const full = await this.github.restText(`${base}/pulls/${number}`, { accept: DIFF });
      const text = since
        ? onlyPrFiles(
            await this.github.restText(`${base}/compare/${since}...${head}`, { accept: DIFF }),
            full,
          )
        : full;
      return { ...capPatch(text), base: from, head };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      if (since && error.httpStatus === 404) {
        throw new SinceUnknownError(`commit ${since} is no longer on GitHub`);
      }
      if (error.httpStatus === 406) return { patch: "", truncated: true, base: from, head };
      throw rateLimited(error);
    }
  }

  private async files(vars: { owner: string; name: string; number: number }) {
    const files = [];
    let filesTotal = 0;
    let after: string | null = null;
    for (let page = 0; page < MAX_FILE_PAGES; page++) {
      const data: GhFiles = await this.github.graphql(PR_FILES, { ...vars, after }, ghFilesSchema);
      const connection = data.repository.pullRequest?.files;
      if (!connection) break;
      filesTotal = connection.totalCount;
      files.push(...connection.nodes.filter((f) => f !== null));
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return { files, filesTotal };
  }

  /** The newest items, read backwards a page at a time, returned oldest first. */
  private async timeline(vars: { owner: string; name: string; number: number }) {
    let timeline: GhTimelineNode[] = [];
    let before: string | null = null;
    let more = true;
    while (more && timeline.length < MAX_TIMELINE_ITEMS) {
      const data: GhTimeline = await this.github.graphql(
        PR_TIMELINE,
        { ...vars, before },
        ghTimelineSchema,
      );
      const connection = data.repository.pullRequest?.timelineItems;
      if (!connection) break;
      timeline = [...connection.nodes.filter((n) => n !== null), ...timeline];
      more = connection.pageInfo.hasPreviousPage;
      before = connection.pageInfo.startCursor;
    }
    return {
      timeline: timeline.slice(-MAX_TIMELINE_ITEMS),
      timelineTruncated: more || timeline.length > MAX_TIMELINE_ITEMS,
    };
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

/** GitHub's rate limit as a 429 the UI can explain; anything else unchanged. */
function rateLimited(error: unknown): unknown {
  if (!isRateLimit(error)) return error;
  return new GithubRateLimitedError(
    "GitHub's API limit for your gh account is used up; it resets within the hour.",
  );
}
