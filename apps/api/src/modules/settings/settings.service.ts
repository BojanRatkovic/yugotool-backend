import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  NOTIFICATION_EXTERNAL_DEFAULTS,
  type Settings,
  type UpdateSettings,
} from "@yugotool/contracts";
import { settings } from "@yugotool/db";
import { broadcast, type Channel, type DesktopSink, send, truncateNotice } from "@yugotool/notify";
import { eq, sql } from "drizzle-orm";
import { DomainError } from "../../common/errors/domain.error";
import { iso } from "../../common/mappers";
import type { Env } from "../../core/config/env.schema";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";

const ROW_ID = "default";

export class ApiKeyInvalidError extends DomainError {
  readonly code = "api_key_invalid";
  readonly kind = "validation";
}

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
    const { id: _id, anthropicApiKey: saved, ...rest } = row;
    const envKey = this.config.get("ANTHROPIC_API_KEY", { infer: true });
    const key = saved ?? envKey ?? null;
    return {
      ...rest,
      anthropicApiKeyHint: key ? maskApiKey(key) : null,
      anthropicApiKeySource: saved ? "settings" : envKey ? "env" : null,
      notificationExternal: { ...NOTIFICATION_EXTERNAL_DEFAULTS, ...row.notificationExternal },
      updatedAt: iso(row.updatedAt),
    };
  }

  /** The key agents run on: saved in Settings, else ANTHROPIC_API_KEY, else none (plan login). */
  async apiKey(): Promise<string | null> {
    const [row] = await this.database.db
      .select({ key: settings.anthropicApiKey })
      .from(settings)
      .where(eq(settings.id, ROW_ID));
    return row?.key ?? this.config.get("ANTHROPIC_API_KEY", { infer: true }) ?? null;
  }

  async update(patch: UpdateSettings): Promise<Settings> {
    await this.get();
    if (patch.reposRoot) patch = { ...patch, reposRoot: await existingFolder(patch.reposRoot) };
    if (patch.anthropicApiKey) await checkApiKey(patch.anthropicApiKey);
    const { notificationExternal, ...rest } = patch;
    await this.database.db
      .update(settings)
      .set({
        ...rest,
        // Merge into the stored overrides: a patch names only the kinds it changes.
        ...(notificationExternal
          ? {
              notificationExternal: sql`${settings.notificationExternal} || ${JSON.stringify(notificationExternal)}::jsonb`,
            }
          : {}),
      })
      .where(eq(settings.id, ROW_ID));
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
        body: "YugoTool can reach you here.",
        url: `${current.appUrl}/settings`,
      },
      this.desktopSink(),
    );
  }

  /** Every enabled channel; one failing never blocks the others (see `error`). */
  async broadcast(notice: {
    title: string;
    body: string;
    url: string;
  }): Promise<{ channel: Channel; error: string | null }[]> {
    return broadcast(await this.get(), notice, this.desktopSink());
  }

  /** Inside the desktop app, notices travel as events and the app shows them natively. */
  private desktopSink(): DesktopSink | undefined {
    if (this.config.get("DESKTOP_NOTICES", { infer: true }) !== "app") return undefined;
    return (notice) => this.events.publish({ type: "notice", ...truncateNotice(notice) });
  }
}

/** "sk-ant-api03-…x7Qd": enough to recognise the key, useless to anyone reading the screen. */
export function maskApiKey(key: string): string {
  const prefix = /^sk-ant-[a-z]+\d*-/.exec(key)?.[0] ?? key.slice(0, 3);
  return key.length <= prefix.length + 8 ? "…" + key.slice(-2) : `${prefix}…${key.slice(-4)}`;
}

/**
 * Asks Anthropic whether the key works (listing models costs nothing). Only a
 * clear rejection blocks the save; offline, the key is saved unchecked.
 */
export async function checkApiKey(key: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return;
  }
  if (res.status === 401 || res.status === 403)
    throw new ApiKeyInvalidError(
      res.status === 401
        ? "Anthropic rejected this key. Check that it was copied whole and is not revoked."
        : "This key is not allowed to use the API (permission denied).",
    );
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
