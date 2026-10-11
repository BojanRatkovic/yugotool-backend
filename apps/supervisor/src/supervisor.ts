import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { SupervisorConfig } from "./config";
import { LogFile } from "./log-file";
import type { RuntimeProgress } from "./runtime";
import {
  createServices,
  firstFreePort,
  portFree,
  SERVICE_ORDER,
  type Service,
  type ServiceName,
  sleep,
} from "./services";

const serviceStatusSchema = z.object({
  name: z.enum(["runtime", "postgres", "migrations", "temporal", "api", "worker"]),
  state: z.enum(["stopped", "starting", "running", "done", "restarting", "failed"]),
  pid: z.number().int().nullable(),
  port: z.number().int().nullable(),
  /** Last start message or error, one line. */
  detail: z.string().nullable(),
  /** Bytes so far while a start downloads (the runtime step); null otherwise. */
  progress: z.object({ done: z.number(), total: z.number().nullable() }).nullable().default(null),
  restarts: z.number().int(),
  since: z.string(),
  logFile: z.string(),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServiceState = ServiceStatus["state"];

const supervisorStatusSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
  appUrl: z.string(),
  services: z.array(serviceStatusSchema),
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

const HEALTH_EVERY_MS = 5_000;
/** Consecutive failed probes before a running service is restarted. */
const UNHEALTHY_AFTER = 3;
const CRASH_WINDOW_MS = 120_000;
const MAX_CRASHES_IN_WINDOW = 5;

/**
 * Delay before restarting a crashed service: 1 s, 2 s, 4 s … capped at 30 s;
 * null once it crashed too often in the window (stays failed until restarted
 * by hand). Pure for testing.
 */
export function restartDelay(crashTimes: number[], now: number): number | null {
  const recent = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
  if (recent.length >= MAX_CRASHES_IN_WINDOW) return null;
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, recent.length - 1));
}

/**
 * Starts Postgres → migrations → Temporal → API → worker in order, watches
 * them (exit + health probes), restarts crashed ones with backoff and stops
 * them in reverse. Emits "status" with a SupervisorStatus on every change and
 * mirrors it to `~/.zastava/supervisor.json`.
 */
export class Supervisor extends EventEmitter<{ status: [SupervisorStatus] }> {
  private readonly services: Record<ServiceName, Service>;
  private readonly logs = new Map<ServiceName | "supervisor", LogFile>();
  private readonly status = new Map<ServiceName, ServiceStatus>();
  private readonly crashes = new Map<ServiceName, number[]>();
  private readonly failedProbes = new Map<ServiceName, number>();
  private healthTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly config: SupervisorConfig) {
    super();
    this.services = createServices({
      config,
      log: (name) => this.log(name),
      onCrash: (name, reason) => void this.handleCrash(name, reason),
      progress: (name, progress, detail) => this.progress(name, progress, detail),
    });
    for (const name of SERVICE_ORDER) {
      const service = this.services[name];
      this.status.set(name, {
        name,
        state: "stopped",
        pid: null,
        port: service.port,
        detail: null,
        progress: null,
        restarts: 0,
        since: new Date().toISOString(),
        logFile: this.log(name).file,
      });
    }
  }

  get appUrl(): string {
    return `http://127.0.0.1:${this.config.ports.api}`;
  }

  snapshot(): SupervisorStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      appUrl: this.appUrl,
      services: SERVICE_ORDER.map((name) => {
        const s = this.status.get(name);
        if (!s) throw new Error(`no status for ${name}`);
        return { ...s, pid: this.services[name].pid() };
      }),
    };
  }

  async start(): Promise<void> {
    await mkdir(this.config.home, { recursive: true });
    this.claimHome();
    this.log("supervisor").line(`starting (pid ${process.pid})`);
    await this.reapOrphans();
    await this.claimPorts();
    for (const name of SERVICE_ORDER) {
      try {
        await this.startService(name);
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    this.healthTimer = setInterval(() => void this.probe(), HEALTH_EVERY_MS);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.log("supervisor").line("stopping");
    for (const name of SERVICE_ORDER.toReversed()) {
      const current = this.status.get(name)?.state;
      if (current === "stopped") continue;
      try {
        await this.services[name].stop();
      } catch (error) {
        this.log(name).line(`stop failed: ${message(error)}`);
      }
      // A failed row keeps saying so: the loading screen shows which one broke.
      if (current !== "failed") this.set(name, "stopped", null);
    }
    await rm(this.config.stateFile, { force: true });
    await Promise.all([...this.logs.values()].map((log) => log.close()));
  }

  /** Restarts one service by hand (e.g. after it was given up on). */
  async restart(name: ServiceName): Promise<void> {
    this.crashes.set(name, []);
    await this.services[name].stop();
    await this.startService(name);
  }

  private async startService(name: ServiceName): Promise<void> {
    const service = this.services[name];
    this.set(name, "starting", null);
    try {
      const detail = await service.start();
      this.failedProbes.set(name, 0);
      this.set(name, service.oneShot ? "done" : "running", detail ?? null);
    } catch (error) {
      this.set(name, "failed", message(error));
      throw error;
    }
  }

  private async handleCrash(name: ServiceName, reason: string): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    const times = [...(this.crashes.get(name) ?? []), now];
    this.crashes.set(name, times);
    const delay = restartDelay(times, now);
    if (delay === null) {
      this.set(name, "failed", `${reason}; gave up after ${MAX_CRASHES_IN_WINDOW} crashes`);
      return;
    }
    const status = this.status.get(name);
    if (status) status.restarts += 1;
    this.set(name, "restarting", `${reason}; restarting in ${delay / 1000} s`);
    await sleep(delay);
    if (this.stopping) return;
    await this.services[name].stop().catch(() => undefined);
    await this.startService(name).catch((error: unknown) =>
      this.handleCrash(name, `restart failed: ${message(error)}`),
    );
  }

  private async probe(): Promise<void> {
    for (const name of SERVICE_ORDER) {
      if (this.stopping || this.status.get(name)?.state !== "running") continue;
      const ok = await this.services[name].healthy().catch(() => false);
      const failures = ok ? 0 : (this.failedProbes.get(name) ?? 0) + 1;
      this.failedProbes.set(name, failures);
      if (failures === UNHEALTHY_AFTER) {
        void this.handleCrash(name, `health check failed ${UNHEALTHY_AFTER} times`);
      }
    }
  }

  private set(name: ServiceName, state: ServiceState, detail: string | null): void {
    const current = this.status.get(name);
    if (!current) return;
    current.state = state;
    current.detail = detail;
    current.progress = null;
    current.since = new Date().toISOString();
    this.log("supervisor").line(`${name}: ${state}${detail ? ` (${detail})` : ""}`);
    this.publish();
  }

  /** A starting service's progress: shown, not logged (it ticks several times a second). */
  private progress(name: ServiceName, progress: RuntimeProgress, detail: string): void {
    const current = this.status.get(name);
    if (!current || current.state !== "starting") return;
    current.progress = progress;
    current.detail = detail;
    this.publish();
  }

  private publish(): void {
    const snapshot = this.snapshot();
    void writeFile(this.config.stateFile, `${JSON.stringify(snapshot, null, 2)}\n`).catch(
      () => undefined,
    );
    this.emit("status", snapshot);
  }

  /** One supervisor per home: a live pid in supervisor.json means another one runs. */
  private claimHome(): void {
    const other = readStatus(this.config.stateFile);
    if (other && other.pid !== process.pid && pidAlive(other.pid)) {
      throw new Error(`another supervisor (pid ${other.pid}) already runs ${this.config.home}`);
    }
  }

  /**
   * A supervisor that was killed (kill -9, crash) leaves its children running
   * and holding ports. Its last state file lists them; stop the ones that
   * still look like ours. Postgres is handled by its own lock file.
   */
  private async reapOrphans(): Promise<void> {
    const previous = readStatus(this.config.stateFile);
    if (!previous || previous.pid === process.pid || pidAlive(previous.pid)) return;
    const expected: Partial<Record<ServiceName, string>> = {
      temporal: "start-dev",
      api: this.config.apiEntry,
      worker: this.config.workerEntry,
    };
    for (const service of previous.services) {
      const marker = expected[service.name];
      if (!service.pid || !marker || !pidAlive(service.pid)) continue;
      if (!commandOf(service.pid).includes(marker)) continue;
      this.log("supervisor").line(`stopping orphaned ${service.name} (pid ${service.pid})`);
      process.kill(service.pid, "SIGTERM");
      for (let i = 0; i < 50 && pidAlive(service.pid); i++) await sleep(100);
      if (pidAlive(service.pid)) process.kill(service.pid, "SIGKILL");
    }
  }

  /**
   * Ports must be ours before anything starts. Another server on the API port
   * (a dev API on 4810) once answered the readiness probe instead of ours, so
   * the API moves to the next free port; the window follows `appUrl`. Temporal's
   * ports are fixed for its clients, so a taken one stops the start with who has it.
   * Postgres is left to its lock file (an orphan of ours may hold its port).
   */
  private async claimPorts(): Promise<void> {
    const { ports } = this.config;
    for (const [name, port] of [
      ["temporal", ports.temporal],
      ["temporal UI", ports.temporalUi],
      ["temporal HTTP", ports.temporalHttp],
    ] as const) {
      if (!(await portFree(port))) {
        throw new Error(
          `port ${port} (${name}) is in use by ${holderOf(port)}; stop it and start again`,
        );
      }
    }
    const wanted = ports.api;
    if (await portFree(wanted)) return;
    const taken = [ports.pg, ports.temporal, ports.temporalUi, ports.temporalHttp];
    const free = await firstFreePort(wanted + 1, wanted + API_PORT_SPAN, taken);
    if (free === null) {
      throw new Error(
        `port ${wanted} (api) and the next ${API_PORT_SPAN} are in use; free one and start again`,
      );
    }
    this.log("supervisor").line(
      `port ${wanted} is in use by ${holderOf(wanted)}; api uses ${free}`,
    );
    ports.api = free;
    const status = this.status.get("api");
    if (status) this.status.set("api", { ...status, port: free });
  }

  private log(name: ServiceName | "supervisor"): LogFile {
    let log = this.logs.get(name);
    if (!log) {
      log = new LogFile(this.config.logsDir, name);
      this.logs.set(name, log);
    }
    return log;
  }
}

/** The state a running supervisor last wrote, or null. */
export function readStatus(stateFile: string): SupervisorStatus | null {
  try {
    const parsed = supervisorStatusSchema.safeParse(JSON.parse(readFileSync(stateFile, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How far past its configured port the API may move when that one is taken. */
const API_PORT_SPAN = 20;

/** "pid 123 (node …/api/dist/main.js)" for whoever listens on `port`, best effort. */
function holderOf(port: number): string {
  try {
    const pid = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    })
      .split("\n")[0]
      ?.trim();
    if (!pid) return "another process";
    const command = commandOf(Number(pid)).trim().slice(0, 120);
    return `pid ${pid}${command ? ` (${command})` : ""}`;
  } catch {
    return "another process";
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
  }
}
