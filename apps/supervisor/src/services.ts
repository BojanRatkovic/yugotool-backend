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
import { migrate } from "./migrate";

const execFileAsync = promisify(execFile);
const binariesSchema = z.object({ initdb: z.string(), postgres: z.string() });

export type ServiceName = "postgres" | "migrations" | "temporal" | "api" | "worker";

/** Start order; stop runs in reverse. */
export const SERVICE_ORDER: ServiceName[] = ["postgres", "migrations", "temporal", "api", "worker"];

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
}

export function createServices(ctx: ServiceContext): Record<ServiceName, Service> {
  return {
    postgres: postgres(ctx),
    migrations: migrations(ctx),
    temporal: temporal(ctx),
    api: api(ctx),
    worker: worker(ctx),
  };
}

// ── Postgres (bundled binaries, data in ~/.zastava/pg) ───────────────────────

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
      await waitFor(() => pgReady(config, "postgres"), 30_000, "postgres", file);
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
  const scratch = await mkdtemp(path.join(os.tmpdir(), "zastava-pg-"));
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

function pgClient(config: SupervisorConfig, database: string): Client {
  return new Client({
    host: "127.0.0.1",
    port: config.ports.pg,
    user: PG_USER,
    password: PG_PASSWORD,
    database,
    connectionTimeoutMillis: 3_000,
  });
}

async function pgReady(config: SupervisorConfig, database: string): Promise<boolean> {
  const client = pgClient(config, database);
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

// ── Temporal dev server (file DB in ~/.zastava/temporal.db) ───────────────────

function temporal({ config, log, onCrash }: ServiceContext): Service {
  const file = log("temporal");
  const bin = temporalBin(config);
  const child = new Child(
    {
      command: bin,
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
    },
    file,
    (code, signal) => onCrash("temporal", exitReason(code, signal)),
  );
  return {
    name: "temporal",
    oneShot: false,
    port: config.ports.temporal,
    pid: () => child.pid,
    async start() {
      child.start();
      await waitFor(() => portOpen(config.ports.temporal), 30_000, "temporal", file);
      return `UI http://127.0.0.1:${config.ports.temporalUi}`;
    },
    stop: () => child.stop(),
    healthy: () => portOpen(config.ports.temporal),
  };
}

function temporalBin(config: SupervisorConfig): string {
  if (config.temporalBin) return config.temporalBin;
  const bundled = path.join(config.home, "bin", "temporal");
  if (existsSync(bundled)) return bundled;
  try {
    return execFileSync("/usr/bin/which", ["temporal"], {
      env: { PATH: config.path },
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "temporal CLI not found: install it (brew install temporal) or set ZASTAVA_TEMPORAL_BIN",
    );
  }
}

// ── API (NestJS, serves the built frontend) and worker ────────────────────────

/**
 * Env shared by API and worker: the user's PATH (git, gh, nvm…) plus our
 * addresses. No NODE_ENV: the worker's children (previews, agents' Bash)
 * inherit it, and `npm ci` under NODE_ENV=production skips devDependencies.
 */
function nodeEnv(config: SupervisorConfig): NodeJS.ProcessEnv {
  const { NODE_ENV: _nodeEnv, ...inherited } = process.env;
  return {
    ...inherited,
    DATABASE_URL: databaseUrl(config),
    TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`,
    DESKTOP_NOTICES: config.desktopNotices,
    ...config.extraEnv,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
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
  const child = new Child(
    {
      command: config.node,
      args: [config.workerEntry],
      cwd: path.dirname(path.dirname(config.workerEntry)),
      env: nodeEnv(config),
      // Lets in-flight bookkeeping finish; agent sessions are cut (runs fail, can be run again).
      stopTimeoutMs: 30_000,
    },
    file,
    (code, signal) => onCrash("worker", exitReason(code, signal)),
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
