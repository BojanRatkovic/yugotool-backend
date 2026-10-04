import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NOTIFICATION_JOBS_CHANNEL, type Notification } from "@zastava/contracts";
import { Client } from "pg";
import type { Env } from "../../core/config/env.schema";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { SettingsService } from "../settings/settings.service";
import {
  backoffSeconds,
  clamp,
  isExternal,
  MAX_ATTEMPTS,
  renderJob,
} from "./notification-definitions";
import { NotificationsRepository } from "./notifications.repository";

/** Fallback when a NOTIFY is missed (listener down, job delayed by backoff). */
const TICK_MS = 10_000;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1_000;

interface Processed {
  notification: Notification | null;
  external: boolean;
}

/**
 * Turns queued notification jobs into notifications (spec 0011): render →
 * store → mark done in one transaction, then push over SSE and fan out to the
 * external channels. Woken by NOTIFY on enqueue, with a slow tick as backstop.
 * All state is in Postgres; this is only the pump.
 */
@Injectable()
export class NotificationJobsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationJobsProcessor.name);
  private listener: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private again = false;
  private stopped = false;
  private lastSweep = 0;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly repository: NotificationsRepository,
    private readonly events: EventsService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const listener = new Client({
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
    });
    await listener.connect();
    listener.on("notification", () => void this.drain());
    listener.on("error", (error) =>
      this.logger.error("notification job listener failed", error.stack),
    );
    await listener.query(`LISTEN ${NOTIFICATION_JOBS_CHANNEL}`);
    this.listener = listener;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end();
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = Date.now();
      await this.repository
        .sweep(this.database.db)
        .catch((error: unknown) =>
          this.logger.error(
            "notification sweep failed",
            error instanceof Error ? error.stack : error,
          ),
        );
    }
    await this.drain();
  }

  /** Processes due jobs until none are left; a wake-up during a drain runs one more pass. */
  async drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        while (!this.stopped && (await this.processNext()));
      } while (this.again && !this.stopped);
    } catch (error) {
      this.logger.error("notification drain failed", error instanceof Error ? error.stack : error);
    } finally {
      this.draining = false;
    }
  }

  /** Returns false when the queue had nothing due. */
  async processNext(): Promise<boolean> {
    const processed = await this.database.transaction(async (tx) => {
      const claimed = await this.repository.claimNextJob(tx);
      if (!claimed) return null;
      if (!claimed.job) {
        await this.repository.failJob(tx, claimed.id, claimed.parseError ?? "unparseable", null);
        return { notification: null, external: false };
      }
      const { job } = claimed;
      try {
        // A savepoint: a failed render rolls back alone and the job row stays writable.
        const notification = await tx.transaction(async (sp) => {
          const rendered = await renderJob(job, {
            workOrder: (id) => this.repository.workOrderContext(sp, id),
          });
          const stored = rendered
            ? await this.repository.insert(sp, claimed.id, job.kind, clamp(rendered))
            : null;
          await this.repository.completeJob(sp, claimed.id);
          return stored;
        });
        return { notification, external: isExternal(job) } satisfies Processed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = claimed.attempts + 1;
        const retry = attempts < MAX_ATTEMPTS ? backoffSeconds(attempts) : null;
        this.logger.warn(
          `notification job ${claimed.id} (${job.kind}) failed, attempt ${attempts}: ${message}`,
        );
        await this.repository.failJob(tx, claimed.id, message, retry);
        return { notification: null, external: false };
      }
    });
    if (!processed) return false;
    if (processed.notification) await this.deliver(processed.notification, processed.external);
    return true;
  }

  /**
   * After commit, best effort: the bell already has it. Never retried — a
   * second Slack message is worse than a missed one.
   */
  private async deliver(notification: Notification, external: boolean): Promise<void> {
    try {
      await this.events.publish({ type: "notification", notification });
      if (!external) return;
      const { appUrl } = await this.settings.get();
      const results = await this.settings.broadcast({
        title: notification.title,
        body: notification.body,
        url: `${appUrl}${notification.path}`,
      });
      for (const failed of results.filter((r) => r.error)) {
        const message = `Notification via ${failed.channel} failed: ${failed.error}`;
        this.logger.warn(message);
        if (!notification.workOrderId) continue;
        const logged = await this.repository.appendRunError(
          this.database.db,
          notification.workOrderId,
          message,
        );
        if (logged) await this.events.publish({ type: "run_event", ...logged });
      }
    } catch (error) {
      this.logger.error(
        `delivering notification ${notification.id} failed`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
