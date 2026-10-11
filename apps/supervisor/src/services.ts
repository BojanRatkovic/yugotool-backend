import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { z } from "zod";
import { Child, type ChildSpec } from "./child";
import { databaseUrl, PG_DATABASE, PG_PASSWORD, PG_USER, type SupervisorConfig } from "./config";
import type { LogFile } from "./log-file";
import { checkFolderAccess, protectedFolders } from "./folders";
import { LEGACY_NAME, renameLegacyRole } from "./legacy";
import { migrate } from "./migrate";
import { ensureRuntime, findTool, progressText, type RuntimeProgress, toolPath } from "./runtime";

const execFileAsync = promisify(execFile);
const binariesSchema = z.object({ initdb: z.string(), postgres: z.string() });

export type ServiceName =
  | "runtime"
  | "postgres"
  | "migrations"
  | "folders"
  | "temporal"
  | "api"
  | "worker";

/** Start order; stop runs in reverse. */
export const SERVICE_ORDER: ServiceName[] = [
  "runtime",
  "postgres",
  "migrations",
  "folders",
  "temporal",
  "api",
  "worker",
];

export interface Service {
  name: ServiceName;
  /** One-shot services (migrations) finish instead of staying up. */
  oneShot: boolean;
  port: number | null;
  /** Resolves once the service is ready to be used. */
  start(): Promise<string | void>;
  stop(): Promise<void>;
  /** Cheap liveness probe, called every few seconds while running. */
  healthy(): Promise<boolean>;
  pid(): number | null;
}

export interface ServiceContext {
  config: SupervisorConfig;
  log: (name: ServiceName) => LogFile;
  onCrash: (name: ServiceName, reason: string) => void;
  /** A long start reporting how far it got (the runtime download, a macOS dialog). */
  progress: (name: ServiceName, progress: RuntimeProgress, detail: string) => void;
}

export function createServices(ctx: ServiceContext): Record<ServiceName, Service> {
  return {
    runtime: runtime(ctx),
    postgres: postgres(ctx),
    migrations: migrations(ctx),
    folders: folders(ctx),
    temporal: temporal(ctx),
    api: api(ctx),
    worker: worker(ctx),
  };
}

// ── Runtime (packaged app: Claude Code + Temporal, fetched once) ──────────────

/** Progress reports at most this often; a 140 MB download sends thousands of chunks. */
const PROGRESS_EVERY_MS = 200;

function runtime({ config, log, progress }: ServiceContext): Service {
  const file = log("runtime");
  let abort: AbortController | null = null;
  return {
    name: "runtime",
    oneShot: true,
    port: null,
    pid: () => null,
    async start() {
      if (!config.runtime) return "not needed";
      abort = new AbortController();
      let last = 0;
      const fetched = await ensureRuntime(config.home, config.runtime, {
        signal: abort.signal,
        onProgress: (bytes, tools) => {
          const now = Date.now();
          if (now - last < PROGRESS_EVERY_MS && bytes.done !== bytes.total) return;
          last = now;
          const what = tools.map((tool) => tool.label).join(" and ");
          progress("runtime", bytes, `downloading ${what} · ${progressText(bytes)}`);
        },
      });
      for (const tool of fetched) file.line(`fetched ${tool.label} ${tool.version}`);
      return fetched.length
        ? `fetched ${fetched.map((tool) => `${tool.label} ${tool.version}`).join(", ")}`
        : "up to date";
    },
    async stop() {
      abort?.abort();
      abort = null;
    },
    healthy: () => Promise.resolve(true),
  };
}

/** The fetched Claude Code binary, or null to let the Agent SDK find its own. */
export function claudeBin(config: SupervisorConfig): string | null {
  const tool = config.runtime && findTool(config.runtime, "claude");
  return tool ? toolPath(config.home, tool) : null;
}

// ── Postgres (bundled binaries, data in ~/.yugotool/pg) ───────────────────────

/**
 * Runs the `@embedded-postgres/<platform>` binaries directly. The package's
 * JS wrapper is not used: it installs a SIGINT/SIGTERM hook that exits the
 * process mid-shutdown, and it hides the server process from us.
 */
function postgres({ config, log, onCrash }: ServiceContext): Service {
  const file = log("postgres");
  let child: Child | null = null;

  return {
    name: "postgres",
    oneShot: false,
    port: config.ports.pg,
    pid: () => child?.pid ?? null,
    async start() {
      const bin = await postgresBinaries();
      await stopOrphan(config.pgDataDir, file);
      const fresh = !existsSync(path.join(config.pgDataDir, "PG_VERSION"));
      if (fresh) await initdb(bin.initdb, config.pgDataDir, file);
      child = new Child(
        {
          command: bin.postgres,
          args: [
            "-D",
            config.pgDataDir,
            "-p",
            String(config.ports.pg),
            // Loopback TCP only; no unix socket (long paths break it).
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "unix_socket_directories=",
          ],
          cwd: config.pgDataDir,
          env: { PATH: config.path, LC_ALL: "C" },
          // SIGINT = fast shutdown; SIGTERM would wait for every client to leave.
          stopSignal: "SIGINT",
          stopTimeoutMs: 15_000,
        },
        file,
        (code, signal) => onCrash("postgres", exitReason(code, signal)),
      );
      child.start();
      // A cluster from the ZASTAVA days answers to the old role until renamed.
      await waitFor(
        async () =>
          (await pgReady(config, "postgres")) ||
          pgReady(config, "postgres", { user: LEGACY_NAME, password: LEGACY_NAME }),
        30_000,
        "postgres",
        file,
      );
      const renamed = await renameLegacyRole(
        (user, password, database) => pgClient(config, database, { user, password }),
        { user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE },
      );
      if (renamed) file.line(`renamed role and database ${LEGACY_NAME} to ${PG_USER}`);
      await createDatabase(config);
      return fresh ? "initialised a new cluster" : undefined;
    },
    async stop() {
      await child?.stop();
    },
    healthy: () => pgReady(config, PG_DATABASE),
  };
}

async function postgresBinaries(): Promise<{ initdb: string; postgres: string }> {
  const name = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    return binariesSchema.parse(await import(name));
  } catch {
    throw new Error(`no bundled Postgres for ${process.platform}-${process.arch} (${name})`);
  }
}

async function initdb(bin: string, dataDir: string, file: LogFile): Promise<void> {
  await mkdir(path.dirname(dataDir), { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "yugotool-pg-"));
  const pwfile = path.join(scratch, "pw");
  await writeFile(pwfile, `${PG_PASSWORD}\n`, { mode: 0o600 });
  try {
    const { stdout, stderr } = await execFileAsync(bin, [
      `--pgdata=${dataDir}`,
      "--auth=scram-sha-256",
      `--username=${PG_USER}`,
      `--pwfile=${pwfile}`,
      "--encoding=UTF8",
      "--no-locale",
    ]);
    file.write(stdout + stderr);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function createDatabase(config: SupervisorConfig): Promise<void> {
  const client = pgClient(config, "postgres");
  await client.connect();
  try {
    const { rowCount } = await client.query(`select 1 from pg_database where datname = $1`, [
      PG_DATABASE,
    ]);
    if (!rowCount) await client.query(`create database ${PG_DATABASE}`);
  } finally {
    await client.end();
  }
}

function pgClient(
  config: SupervisorConfig,
  database: string,
  login = { user: PG_USER, password: PG_PASSWORD },
): Client {
  return new Client({
    host: "127.0.0.1",
    port: config.ports.pg,
    user: login.user,
    password: login.password,
    database,
    connectionTimeoutMillis: 3_000,
  });
}

async function pgReady(
  config: SupervisorConfig,
  database: string,
  login?: { user: string; password: string },
): Promise<boolean> {
  const client = pgClient(config, database, login);
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A postgres left running by a supervisor that was killed holds the lock file; stop it first. */
async function stopOrphan(dataDir: string, file: LogFile): Promise<void> {
  const pid = postmasterPid(dataDir);
  if (!pid || !alive(pid)) return;
  file.line(`stopping orphaned postgres (pid ${pid})`);
  process.kill(pid, "SIGINT");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
}

function postmasterPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// ── Migrations (one-shot) ─────────────────────────────────────────────────────

function migrations({ config, log }: ServiceContext): Service {
  const file = log("migrations");
  return {
    name: "migrations",
    oneShot: true,
    port: null,
    pid: () => null,
    async start() {
      const client = new Client({ connectionString: databaseUrl(config) });
      await client.connect();
      try {
        const applied = await migrate(client, config.migrationsDir);
        for (const tag of applied) file.line(`applied ${tag}`);
        return applied.length ? `applied ${applied.length}` : "up to date";
      } finally {
        await client.end();
      }
    },
    stop: () => Promise.resolve(),
    healthy: () => Promise.resolve(true),
  };
}

// ── Folder access (one-shot, macOS) ───────────────────────────────────────────

/**
 * Asks macOS for the guarded folders (Desktop, Documents, Downloads) the
 * projects and the repos folder live in, before the API reads them. Unanswered,
 * the dialog blocks those reads and the API hangs; here the loading screen
 * says what it waits for. A refusal fails the start only for a project's folder.
 */
function folders({ config, log, progress }: ServiceContext): Service {
  const file = log("folders");
  let abort: AbortController | null = null;
  return {
    name: "folders",
    oneShot: true,
    port: null,
    pid: () => null,
    async start() {
      if (process.platform !== "darwin") return "not needed";
      const { projects, reposRoot } = await folderPaths(config);
      const needed = new Set(protectedFolders(projects));
      const wanted = protectedFolders([...projects, reposRoot ?? config.reposRoot]);
      if (wanted.length === 0) return "not needed";
      abort = new AbortController();
      const denied: string[] = [];
      for (const folder of wanted) {
        const name = path.basename(folder);
        const access = await checkFolderAccess(folder, {
          signal: abort.signal,
          onWaiting: () => {
            file.line(`waiting for the macOS dialog for ${folder}`);
            progress("folders", { done: 0, total: null }, `allow access to your ${name} folder`);
          },
        });
        file.line(`${folder}: ${access}`);
        if (access === "granted") continue;
        if (needed.has(folder)) {
          throw new Error(
            `YugoTool can't read your ${name} folder, where your projects are. Allow it in System Settings → Privacy & Security → Files and Folders → YugoTool, then try again`,
          );
        }
        denied.push(name);
      }
      return denied.length
        ? `no access to ${denied.join(", ")}; pick another repos folder in Settings`
        : wanted.map((folder) => path.basename(folder)).join(", ");
    },
    async stop() {
      abort?.abort();
      abort = null;
    },
    healthy: () => Promise.resolve(true),
  };
}

async function folderPaths(
  config: SupervisorConfig,
): Promise<{ projects: string[]; reposRoot: string | null }> {
  const client = new Client({ connectionString: databaseUrl(config) });
  await client.connect();
  try {
    const projects = await client.query<{ repo_path: string }>(`select repo_path from projects`);
    const settings = await client.query<{ repos_root: string | null }>(
      `select repos_root from settings limit 1`,
    );
    return {
      projects: projects.rows.map((row) => row.repo_path),
      reposRoot: settings.rows[0]?.repos_root ?? null,
    };
  } finally {
    await client.end();
  }
}

// ── Temporal dev server (file DB in ~/.yugotool/temporal.db) ───────────────────

function temporal({ config, log, onCrash }: ServiceContext): Service {
  const file = log("temporal");
  // Resolved at start: in a packaged app the binary is fetched by the runtime step.
  const spec = (): ChildSpec => ({
    command: temporalBin(config),
    args: [
      "server",
      "start-dev",
      "--db-filename",
      config.temporalDb,
      "--ip",
      "127.0.0.1",
      "--port",
      String(config.ports.temporal),
      "--ui-port",
      String(config.ports.temporalUi),
      "--http-port",
      String(config.ports.temporalHttp),
      "--log-level",
      "warn",
    ],
    cwd: config.home,
    env: { PATH: config.path },
    stopTimeoutMs: 10_000,
  });
  let child: Child | null = null;
  return {
    name: "temporal",
    oneShot: false,
    port: config.ports.temporal,
    pid: () => child?.pid ?? null,
    async start() {
      child = new Child(spec(), file, (code, signal) =>
        onCrash("temporal", exitReason(code, signal)),
      );
      child.start();
      await waitFor(() => portOpen(config.ports.temporal), 30_000, "temporal", file);
      return `UI http://127.0.0.1:${config.ports.temporalUi}`;
    },
    stop: async () => {
      await child?.stop();
    },
    healthy: () => portOpen(config.ports.temporal),
  };
}

function temporalBin(config: SupervisorConfig): string {
  if (config.temporalBin) return config.temporalBin;
  const fetched = config.runtime && findTool(config.runtime, "temporal");
  if (fetched) return toolPath(config.home, fetched);
  const bundled = path.join(config.home, "bin", "temporal");
  if (existsSync(bundled)) return bundled;
  try {
    return execFileSync("/usr/bin/which", ["temporal"], {
      env: { PATH: config.path },
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "temporal CLI not found: install it (brew install temporal) or set YUGOTOOL_TEMPORAL_BIN",
    );
  }
}

// ── API (NestJS, serves the built frontend) and worker ────────────────────────

/**
 * Env shared by API and worker: the user's PATH (git, gh…) plus our
 * addresses. No NODE_ENV: the worker's children (previews, agents' Bash)
 * inherit it, and `npm ci` under NODE_ENV=production skips devDependencies.
 */
function nodeEnv(config: SupervisorConfig): NodeJS.ProcessEnv {
  const { NODE_ENV: _nodeEnv, ...inherited } = withoutClaudeSession(process.env);
  const claude = claudeBin(config);
  return {
    ...inherited,
    DATABASE_URL: databaseUrl(config),
    TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`,
    DESKTOP_NOTICES: config.desktopNotices,
    // Every Agent SDK session runs this binary (spec 0017).
    ...(claude ? { YUGOTOOL_CLAUDE_BIN: claude } : {}),
    ...config.extraEnv,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
}

/**
 * Variables a Claude Code session sets for its own children. Started from such
 * a terminal, the app passed them on and every Agent SDK session it ran took
 * itself for a child of that session and hung. User settings (CLAUDE_CONFIG_DIR,
 * CLAUDE_CODE_USE_BEDROCK…) stay. Pure.
 */
export function withoutClaudeSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const session =
    /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_.+|MESSAGING_.+|SDK_.+))$/;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !session.test(key)));
}

function apiEnv(config: SupervisorConfig): NodeJS.ProcessEnv {
  const port = config.ports.api;
  return {
    ...nodeEnv(config),
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    WEB_DIST: config.webDist,
    APP_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  };
}

function api({ config, log, onCrash }: ServiceContext): Service {
  const file = log("api");
  const spec: ChildSpec = {
    command: config.node,
    args: [config.apiEntry],
    cwd: path.dirname(path.dirname(config.apiEntry)),
    env: apiEnv(config),
    stopTimeoutMs: 10_000,
  };
  const child = new Child(spec, file, (code, signal) => onCrash("api", exitReason(code, signal)));
  const health = (): string => `http://127.0.0.1:${config.ports.api}/api/health`;
  // Ours, not just anything on the port: a dev API on the same port answered
  // for it once, so the app waited 30 s on the wrong server and gave up.
  const ours = (): Promise<boolean> => answersAs(health(), child.pid);
  return {
    name: "api",
    oneShot: false,
    // The supervisor may move the API to a free port before it starts.
    get port() {
      return config.ports.api;
    },
    pid: () => child.pid,
    async start() {
      if (!existsSync(config.apiEntry)) throw new Error(`API not built: ${config.apiEntry}`);
      if (!existsSync(path.join(config.webDist, "index.html"))) {
        throw new Error(`frontend not built: ${config.webDist}`);
      }
      spec.env = apiEnv(config);
      child.start();
      await waitFor(ours, 30_000, "api", file);
      return `http://127.0.0.1:${config.ports.api}`;
    },
    stop: () => child.stop(),
    healthy: ours,
  };
}

function worker({ config, log, onCrash }: ServiceContext): Service {
  const file = log("worker");
  const spec: ChildSpec = {
    command: config.node,
    args: [config.workerEntry],
    cwd: path.dirname(path.dirname(config.workerEntry)),
    env: nodeEnv(config),
    // Lets in-flight bookkeeping finish; agent sessions are cut (runs fail, can be run again).
    stopTimeoutMs: 30_000,
  };
  const child = new Child(spec, file, (code, signal) =>
    onCrash("worker", exitReason(code, signal)),
  );
  return {
    name: "worker",
    oneShot: false,
    port: null,
    pid: () => child.pid,
    async start() {
      if (!existsSync(config.workerEntry))
        throw new Error(`worker not built: ${config.workerEntry}`);
      await mkdir(config.home, { recursive: true });
      // PATH may have changed since (the desktop app reads the login shell late).
      spec.env = nodeEnv(config);
      child.start();
      // The worker logs nothing on success; staying up for a few seconds means it connected.
      await sleep(3_000);
      if (!child.pid) throw new Error(`worker exited at start; see ${file.file}`);
    },
    stop: () => child.stop(),
    healthy: () => Promise.resolve(child.pid !== null),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `killed by ${signal}` : `exited with code ${code ?? "?"}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  file: LogFile,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(300);
  }
  throw new Error(`${what} not ready after ${timeoutMs / 1000} s; see ${file.file}`);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether `url` is our process's health endpoint: it reports the pid we started. */
export async function answersAs(url: string, pid: number | null): Promise<boolean> {
  if (pid === null) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && Reflect.get(body, "pid") === pid;
  } catch {
    return false;
  }
}

/** Free = nothing answers on 127.0.0.1 and we can bind it (catches `*:port` listeners too). */
export async function portFree(port: number): Promise<boolean> {
  if (await portOpen(port)) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** The first free port in [from, to], skipping `taken`; null when all are busy. */
export async function firstFreePort(
  from: number,
  to: number,
  taken: number[] = [],
): Promise<number | null> {
  for (let port = from; port <= to; port++) {
    if (taken.includes(port)) continue;
    if (await portFree(port)) return port;
  }
  return null;
}
