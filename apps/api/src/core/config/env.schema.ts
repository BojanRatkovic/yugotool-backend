import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * The single source of environment configuration. `process.env` is handed to
 * `validateEnv` by `ConfigModule.forRoot` — no other file reads it.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4810),
  DATABASE_URL: z.string().default("postgres://localhost:5432/zastava"),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  /** Comma-separated origins allowed by CORS (the Vite dev server proxies, so this is for prod). */
  /** Folder the repo picker scans for git repositories. */
  REPOS_ROOT: z.string().default(path.join(os.homedir(), "Desktop", "Developer")),
  /** Only read to report the auth source; the worker's SDK consumes it. */
  ANTHROPIC_API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:4800"),
  /**
   * Built frontend (zastava-frontend/dist) to serve at `/`; the API then moves
   * under `/api`, the same paths the Vite dev proxy exposes. Unset in dev.
   */
  WEB_DIST: z.string().optional(),
  /** Seeds Settings → app URL (notification deep links) when the settings row is first created. */
  APP_URL: z.string().optional(),
  /** "app": desktop notices go to the desktop app (as events) instead of osascript. */
  DESKTOP_NOTICES: z.enum(["osascript", "app"]).default("osascript"),
  /** Interface to bind; the desktop app keeps it on loopback. */
  HOST: z.string().optional(),
  /** The Claude Code binary for `claude auth …` (spec 0016); tests point it at a stub. */
  CLAUDE_BIN: z.string().default("claude"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}

/**
 * The environment child processes inherit (`claude auth …`), before a Claude
 * account adjusts it. Read here so this file stays the only `process.env` reader.
 */
export function childProcessEnv(): Record<string, string | undefined> {
  return { ...process.env };
}
