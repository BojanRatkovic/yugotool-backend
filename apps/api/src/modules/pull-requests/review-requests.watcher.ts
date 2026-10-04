import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { enqueueNotification, hasNotificationJobs } from "@zastava/notify";
import { DatabaseService } from "../../core/database/database.service";
import { ProjectsService } from "../projects/projects.service";
import { PullRequestsService } from "./pull-requests.service";
import { reviewRequestJobs, reviewRequestPrefix } from "./review-requests";

const POLL_MS = 5 * 60_000;
/** Let the API settle (and the desktop app open) before the first round of gh calls. */
const FIRST_POLL_MS = 30_000;

/**
 * Polls each GitHub project's review requests and queues a notification for
 * new ones (spec 0011). PRs are never stored (spec 0008); the notification
 * jobs' dedupe keys are the only memory. A project's first look is a
 * baseline: what is already waiting is not news.
 */
@Injectable()
export class ReviewRequestsWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReviewRequestsWatcher.name);
  private timers: NodeJS.Timeout[] = [];
  private polling = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly projects: ProjectsService,
    private readonly pullRequests: PullRequestsService,
  ) {}

  onModuleInit(): void {
    this.timers.push(
      setTimeout(() => void this.poll(), FIRST_POLL_MS),
      setInterval(() => void this.poll(), POLL_MS),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const project of await this.projects.list()) {
        await this.pollProject(project.id).catch((error: unknown) =>
          // gh missing, logged out, offline, rate limited: try again next round.
          this.logger.debug(
            `review requests for ${project.name} skipped: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    } finally {
      this.polling = false;
    }
  }

  async pollProject(projectId: string): Promise<number> {
    const remote = await this.projects.remote(projectId);
    if (!remote.prPossible) return 0;
    const list = await this.pullRequests.list(projectId, "assigned", false);
    const db = this.database.db;
    const silent = !(await hasNotificationJobs(db, reviewRequestPrefix(projectId)));
    const jobs = reviewRequestJobs(projectId, list);
    for (const { job, dedupeKey } of jobs) {
      await enqueueNotification(db, job, dedupeKey, { silent });
    }
    if (silent) {
      // Marks the project as seen even with nothing waiting, or its first request would be swallowed.
      await enqueueNotification(
        db,
        {
          kind: "pr_review_requested",
          payload: { projectId, number: 1, title: "(baseline)", author: "", repo: list.repo },
        },
        `${reviewRequestPrefix(projectId)}baseline`,
        { silent: true },
      );
    }
    return silent ? 0 : jobs.length;
  }
}
