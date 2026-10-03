import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Settings, UpdateSettings } from "@zastava/contracts";
import { settings } from "@zastava/db";
import { broadcast, type Channel, type DesktopSink, send, truncateNotice } from "@zastava/notify";
import { eq } from "drizzle-orm";
import { DomainError } from "../../common/errors/domain.error";
import { iso } from "../../common/mappers";
import type { Env } from "../../core/config/env.schema";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";

const ROW_ID = "default";

export class ReposRootInvalidError extends DomainError {
  readonly code = "repos_root_invalid";
  readonly kind = "validation";
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly events: EventsService,
  ) {}

  /** The row is created lazily with column defaults on first read. */
  async get(): Promise<Settings> {
    const appUrl = this.config.get("APP_URL", { infer: true });
    await this.database.db
      .insert(settings)
      .values({ id: ROW_ID, ...(appUrl ? { appUrl } : {}) })
      .onConflictDoNothing();
    const [row] = await this.database.db.select().from(settings).where(eq(settings.id, ROW_ID));
    if (!row) throw new Error("settings row missing after upsert");
    const { id: _id, ...rest } = row;
    return { ...rest, updatedAt: iso(row.updatedAt) };
  }

  async update(patch: UpdateSettings): Promise<Settings> {
    await this.get();
    if (patch.reposRoot) patch = { ...patch, reposRoot: await existingFolder(patch.reposRoot) };
    await this.database.db.update(settings).set(patch).where(eq(settings.id, ROW_ID));
    await this.events.publish({ type: "invalidate", collection: "settings" });
    await this.events.publish({ type: "invalidate", collection: "dispatcher" });
    return this.get();
  }

  async sendTest(channel: Channel): Promise<void> {
    const current = await this.get();
    await send(
      channel,
      current,
      {
        title: "Test notification",
        body: "ZASTAVA can reach you here.",
        url: `${current.appUrl}/settings`,
      },
      this.desktopSink(),
    );
  }

  async broadcast(notice: { title: string; body: string; url: string }): Promise<void> {
    await broadcast(await this.get(), notice, this.desktopSink());
  }

  /** Inside the desktop app, notices travel as events and the app shows them natively. */
  private desktopSink(): DesktopSink | undefined {
    if (this.config.get("DESKTOP_NOTICES", { infer: true }) !== "app") return undefined;
    return (notice) => this.events.publish({ type: "notice", ...truncateNotice(notice) });
  }
}

/** Expands `~`, resolves to an absolute path and checks it is a folder. */
async function existingFolder(input: string): Promise<string> {
  const expanded = input === "~" || input.startsWith("~/") ? os.homedir() + input.slice(1) : input;
  if (!path.isAbsolute(expanded))
    throw new ReposRootInvalidError(`Use an absolute path or ~/…, got "${input}".`);
  const resolved = path.resolve(expanded);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new ReposRootInvalidError(`${resolved} is not a folder.`);
  return resolved;
}
