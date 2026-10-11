import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readRuntimeManifest, type RuntimeManifest } from "./runtime";

/** apps/supervisor/dist → the yugotool-backend checkout. */
const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * Everything the supervisor needs, from the environment with defaults for a
 * checkout next to yugotool-frontend. The desktop app passes explicit paths.
 * Ports default to a block (4810–4835) that stays clear of common dev ports.
 */
const envSchema = z.object({
  YUGOTOOL_HOME: z.string().default(path.join(os.homedir(), ".yugotool")),
  YUGOTOOL_API_PORT: z.coerce.number().int().positive().default(4810),
  YUGOTOOL_PG_PORT: z.coerce.number().int().positive().default(4832),
  YUGOTOOL_TEMPORAL_PORT: z.coerce.number().int().positive().default(4833),
  YUGOTOOL_TEMPORAL_UI_PORT: z.coerce.number().int().positive().default(4834),
  YUGOTOOL_TEMPORAL_HTTP_PORT: z.coerce.number().int().positive().default(4835),
  /** `temporal` CLI; default: ~/.yugotool/bin/temporal, else the one on PATH. */
  YUGOTOOL_TEMPORAL_BIN: z.string().optional(),
  /**
   * runtime.json of a packaged app (spec 0017): Claude Code and Temporal are
   * fetched into ~/.yugotool/runtime on first start. Unset in a checkout.
   */
  YUGOTOOL_RUNTIME_MANIFEST: z.string().optional(),
  YUGOTOOL_BACKEND_ROOT: z.string().default(BACKEND_ROOT),
  YUGOTOOL_WEB_DIST: z.string().default(path.join(BACKEND_ROOT, "..", "yugotool-frontend", "dist")),
  /** Node used for the API and worker; default: the one running the supervisor. */
  YUGOTOOL_NODE: z.string().default(process.execPath),
  /** Passed through to the worker (API-key auth instead of the Claude login). */
  ANTHROPIC_API_KEY: z.string().optional(),
  PATH: z.string().default("/usr/bin:/bin"),
  /** The API's default repos folder (same default); Settings may override it. */
  REPOS_ROOT: z.string().default(path.join(os.homedir(), "Desktop", "Developer")),
  /** "app" when the desktop app shows notifications itself. */
  YUGOTOOL_DESKTOP_NOTICES: z.enum(["osascript", "app"]).default("osascript"),
});

export interface SupervisorConfig {
  home: string;
  logsDir: string;
  pgDataDir: string;
  temporalDb: string;
  stateFile: string;
  ports: { api: number; pg: number; temporal: number; temporalUi: number; temporalHttp: number };
  temporalBin: string | null;
  /** Binaries to fetch on start; null = use what is installed (a checkout). */
  runtime: RuntimeManifest | null;
  backendRoot: string;
  migrationsDir: string;
  apiEntry: string;
  workerEntry: string;
  webDist: string;
  node: string;
  anthropicApiKey: string | undefined;
  path: string;
  /** Default repos folder; the folders step asks macOS for its guarded parent. */
  reposRoot: string;
  desktopNotices: "osascript" | "app";
  /** Added to the API's and worker's env (the desktop app sets ELECTRON_RUN_AS_NODE). */
  extraEnv?: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const e = envSchema.parse(env);
  const home = path.resolve(e.YUGOTOOL_HOME);
  const backend = path.resolve(e.YUGOTOOL_BACKEND_ROOT);
  return {
    home,
    logsDir: path.join(home, "logs"),
    pgDataDir: path.join(home, "pg"),
    temporalDb: path.join(home, "temporal.db"),
    stateFile: path.join(home, "supervisor.json"),
    ports: {
      api: e.YUGOTOOL_API_PORT,
      pg: e.YUGOTOOL_PG_PORT,
      temporal: e.YUGOTOOL_TEMPORAL_PORT,
      temporalUi: e.YUGOTOOL_TEMPORAL_UI_PORT,
      temporalHttp: e.YUGOTOOL_TEMPORAL_HTTP_PORT,
    },
    temporalBin: e.YUGOTOOL_TEMPORAL_BIN ?? null,
    runtime: e.YUGOTOOL_RUNTIME_MANIFEST ? readRuntimeManifest(e.YUGOTOOL_RUNTIME_MANIFEST) : null,
    backendRoot: backend,
    migrationsDir: path.join(backend, "packages", "db", "migrations"),
    apiEntry: path.join(backend, "apps", "api", "dist", "main.js"),
    workerEntry: path.join(backend, "apps", "worker", "dist", "worker.js"),
    webDist: path.resolve(e.YUGOTOOL_WEB_DIST),
    node: e.YUGOTOOL_NODE,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    path: e.PATH,
    reposRoot: e.REPOS_ROOT,
    desktopNotices: e.YUGOTOOL_DESKTOP_NOTICES,
  };
}

export const PG_USER = "yugotool";
export const PG_PASSWORD = "yugotool";
export const PG_DATABASE = "yugotool";

export function databaseUrl(config: SupervisorConfig): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${config.ports.pg}/${PG_DATABASE}`;
}
