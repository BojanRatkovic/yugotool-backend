import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Database, settings } from "@zastava/db";
import { eq } from "drizzle-orm";

let db: Database | null = null;

/** Called once at start-up; sessions then read the key Settings holds at that moment. */
export function readApiKeyFrom(database: Database): void {
  db = database;
}

/**
 * Adds the API key saved in Settings to a session's options (on top of the
 * env the sandbox sets). It wins over the worker's ANTHROPIC_API_KEY and takes
 * effect on the next session, no restart. Without one, the session keeps the
 * worker's env (plan login or env key).
 */
export async function withApiKey<T extends Pick<Options, "env">>(options: T): Promise<T> {
  if (!db) return options;
  const [row] = await db
    .select({ key: settings.anthropicApiKey })
    .from(settings)
    .where(eq(settings.id, "default"));
  if (!row?.key) return options;
  return { ...options, env: { ...(options.env ?? process.env), ANTHROPIC_API_KEY: row.key } };
}

/**
 * A rejected key is not worth retrying: the SDK would retry 401s for minutes
 * and then end without a reason. Returns what to tell the user, else null.
 */
export function authRejection(message: SDKMessage): string | null {
  if (message.type !== "system" || message.subtype !== "api_retry") return null;
  if (message.error_status === 401)
    return "Anthropic rejected the API key (401). Replace or remove it in Settings → Claude access.";
  if (message.error_status === 403)
    return "The API key is not allowed to use this model (403). Check it in Settings → Claude access.";
  return null;
}
