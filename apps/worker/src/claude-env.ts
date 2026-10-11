import os from "node:os";
import path from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeAccountEnv, type ClaudeAuthTarget } from "@yugotool/contracts";
import { claudeAccounts, type Database, projects, runs, settings, workOrders } from "@yugotool/db";
import { eq } from "drizzle-orm";

let db: Database | null = null;

/** Called once at start-up; each session then reads the accounts as they are at that moment. */
export function readApiKeyFrom(database: Database): void {
  db = database;
}

type AccountRow = typeof claudeAccounts.$inferSelect;

/** Who a session signs in as (spec 0016). */
export interface ClaudeAuth {
  /** null: the worker's own environment, exactly as before accounts. */
  target: ClaudeAuthTarget | null;
  /** The account's Claude Code dir, where its installed plugins live (hub plugins, `/` skills). */
  configDir: string;
  /** "bojan@acme.io (team)" or "CI (API key)"; null = the environment's, unnamed. */
  label: string | null;
}

/**
 * The project's account, else the default one, else the API key saved in
 * Settings before accounts existed, else the environment. Pure.
 */
export function resolveClaudeAuth(
  found: { project: AccountRow | null; fallback: AccountRow | null; legacyKey: string | null },
  env: Record<string, string | undefined>,
  home: string,
): ClaudeAuth {
  const envDir = env["CLAUDE_CONFIG_DIR"] ?? path.join(home, ".claude");
  const account = found.project ?? found.fallback;
  if (!account) {
    return {
      target: found.legacyKey
        ? { kind: "api_key", configDir: null, apiKey: found.legacyKey }
        : null,
      configDir: envDir,
      label: null,
    };
  }
  const target = { kind: account.kind, configDir: account.configDir, apiKey: account.apiKey };
  if (account.kind === "api_key")
    return { target, configDir: envDir, label: `${account.label} (API key)` };
  const plan = account.subscriptionType ? ` (${account.subscriptionType})` : "";
  return {
    target,
    configDir: account.configDir ?? envDir,
    label: account.email ? `${account.email}${plan}` : account.label,
  };
}

/** The account a run's sessions use: its work order's project's, else the default. */
export async function claudeAuthFor(
  scope: { runId: string } | { projectId: string },
): Promise<ClaudeAuth> {
  let project: AccountRow | null = null;
  let fallback: AccountRow | null = null;
  let legacyKey: string | null = null;
  if (db) {
    const [projectRow] =
      "runId" in scope
        ? await db
            .select({ account: claudeAccounts })
            .from(runs)
            .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
            .innerJoin(projects, eq(projects.id, workOrders.projectId))
            .leftJoin(claudeAccounts, eq(claudeAccounts.id, projects.claudeAccountId))
            .where(eq(runs.id, scope.runId))
        : await db
            .select({ account: claudeAccounts })
            .from(projects)
            .leftJoin(claudeAccounts, eq(claudeAccounts.id, projects.claudeAccountId))
            .where(eq(projects.id, scope.projectId));
    project = projectRow?.account ?? null;
    const [settingsRow] = await db
      .select({ account: claudeAccounts, key: settings.anthropicApiKey })
      .from(settings)
      .leftJoin(claudeAccounts, eq(claudeAccounts.id, settings.defaultClaudeAccountId))
      .where(eq(settings.id, "default"));
    fallback = settingsRow?.account ?? null;
    legacyKey = settingsRow?.key ?? null;
  }
  return resolveClaudeAuth({ project, fallback, legacyKey }, process.env, os.homedir());
}

/**
 * A session's options signed in as `auth` (on top of the env the sandbox sets):
 * a config dir sets CLAUDE_CONFIG_DIR and drops ANTHROPIC_API_KEY, an API key
 * is set, no account keeps the env. Takes effect on the next session, no restart.
 */
export function withClaudeAuth<T extends Pick<Options, "env">>(options: T, auth: ClaudeAuth): T {
  if (!auth.target) return options;
  return {
    ...options,
    env: claudeAccountEnv(options.env ?? process.env, auth.target, os.homedir()),
  };
}

/** The Activity line's suffix naming the account, when one is set. */
export const accountNote = (auth: ClaudeAuth): string => (auth.label ? ` · ${auth.label}` : "");

/**
 * A rejected key is not worth retrying: the SDK would retry 401s for minutes
 * and then end without a reason. Returns what to tell the user, else null.
 */
export function authRejection(message: SDKMessage): string | null {
  if (message.type !== "system" || message.subtype !== "api_retry") return null;
  if (message.error_status === 401)
    return "Anthropic rejected the API key (401). Replace or remove it in Settings → Claude accounts.";
  if (message.error_status === 403)
    return "The API key is not allowed to use this model (403). Check it in Settings → Claude accounts.";
  return null;
}
