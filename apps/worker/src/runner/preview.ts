import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import type { Preview } from "@zastava/contracts";

/** Log kept per preview; enough for a tail in the UI and the failure report. */
const MAX_LOG_CHARS = 100_000;
// oxlint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Dev servers colour their output; the UI shows plain text. Pure. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
const POLL_MS = 500;
/** Time a process group gets to exit after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 3_000;

/** The app could not be installed or did not come up; `logs` holds the tail. */
export class PreviewError extends Error {
  constructor(
    message: string,
    readonly logs: string,
  ) {
    super(message);
  }
}

export interface RunningPreview {
  url: string;
  port: number;
  /** The second free port (`$PORT2`), e.g. for a mock API server. */
  port2: number;
  logs(): string;
  /** Kills the whole process group and waits until the port is free. Idempotent. */
  stop(): Promise<void>;
}

export interface PreviewOptions {
  cwd: string;
  preview: Preview;
  /** Shown in log lines, e.g. "base" or "pr". */
  label: string;
  onLog?: (line: string) => void;
  onProgress?: () => void;
  signal?: AbortSignal;
}

/** Asks the OS for a free TCP port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Replaces `$PORT2` and `$PORT` (in that order: `$PORT` is a prefix of `$PORT2`). */
export function withPorts(text: string, ports: { port: number; port2: number }): string {
  return text.replaceAll("$PORT2", String(ports.port2)).replaceAll("$PORT", String(ports.port));
}

/** Two distinct free ports. */
async function freePorts(): Promise<{ port: number; port2: number }> {
  const port = await freePort();
  for (;;) {
    const port2 = await freePort();
    if (port2 !== port) return { port, port2 };
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Full URL of `path` on a preview, honouring the project's baseUrlPath. */
export function previewUrl(origin: string, preview: Preview, path: string): string {
  return joinUrl(joinUrl(origin, preview.baseUrlPath), path);
}

/**
 * Repos pin Node in `.nvmrc` / `.node-version`; the worker runs whatever Node
 * it was started with. With nvm installed, commands run under the pinned
 * version unless they already call nvm. Pure: the caller checks the files.
 */
export function withPinnedNode(
  command: string,
  pin: { nvmrc: boolean; nodeVersion: boolean },
  nvmScript: string | null,
): string {
  if (!nvmScript || /\bnvm\b/.test(command)) return command;
  const use = pin.nvmrc
    ? "nvm use --silent"
    : pin.nodeVersion
      ? 'nvm use --silent "$(cat .node-version)"'
      : null;
  return use ? `. "${nvmScript}" && ${use} && ${command}` : command;
}

function pinnedNode(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const nvmDir = env.NVM_DIR ?? nodePath.join(os.homedir(), ".nvm");
  const script = nodePath.join(nvmDir, "nvm.sh");
  return withPinnedNode(
    command,
    {
      nvmrc: existsSync(nodePath.join(cwd, ".nvmrc")),
      nodeVersion: existsSync(nodePath.join(cwd, ".node-version")),
    },
    existsSync(script) ? script : null,
  );
}

function spawnGroup(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  // detached = its own process group, so stop() can kill dev servers and their children.
  return spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Installs (when configured) and starts the app on a free port, then polls
 * readyPath until it answers. Throws PreviewError with the log tail when the
 * install fails, the process exits, or it never becomes ready.
 */
export async function startPreview(options: PreviewOptions): Promise<RunningPreview> {
  const { cwd, preview, label } = options;
  let log = "";
  const append = (raw: string): void => {
    const chunk = stripAnsi(raw);
    log = (log + chunk).slice(-MAX_LOG_CHARS);
    for (const line of chunk.split("\n")) if (line.trim()) options.onLog?.(`[${label}] ${line}`);
    options.onProgress?.();
  };
  const ports = await freePorts();
  const { port, port2 } = ports;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(preview.env).map(([key, value]) => [key, withPorts(value, ports)]),
    ),
    PORT: String(port),
    PORT2: String(port2),
    BROWSER: "none",
    CI: "1",
  };

  if (preview.install) {
    const installCommand = pinnedNode(preview.install, cwd, env);
    append(`$ ${installCommand}\n`);
    const install = spawnGroup(installCommand, cwd, env);
    install.stdout?.on("data", (c: Buffer) => append(c.toString()));
    install.stderr?.on("data", (c: Buffer) => append(c.toString()));
    const abort = (): void => killGroup(install, "SIGKILL");
    options.signal?.addEventListener("abort", abort);
    const code = await new Promise<number | null>((resolve) => install.on("close", resolve));
    options.signal?.removeEventListener("abort", abort);
    if (code !== 0) throw new PreviewError(`Install failed (exit ${code}) for ${label}`, log);
  }

  const command = pinnedNode(withPorts(preview.start, ports), cwd, env);
  append(`$ ${command}\n`);
  const child = spawnGroup(command, cwd, env);
  child.stdout?.on("data", (c: Buffer) => append(c.toString()));
  child.stderr?.on("data", (c: Buffer) => append(c.toString()));
  let exited: number | null | undefined;
  child.on("exit", (code) => {
    exited = code;
  });
  const hasExited = (): boolean => exited !== undefined;

  const busy = async (): Promise<boolean> => (await portInUse(port)) || portInUse(port2);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    killGroup(child, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && (!hasExited() || (await busy()))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    killGroup(child, "SIGKILL");
    // A grandchild that left the group can still hold a port; give it a moment.
    for (let i = 0; i < 20 && (await busy()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const origin = `http://localhost:${port}`;
  const readyUrl = previewUrl(origin, preview, preview.readyPath);
  const deadline = Date.now() + preview.readyTimeoutSec * 1000;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new PreviewError(`Cancelled while starting ${label}`, log);
      if (hasExited())
        throw new PreviewError(`\`${command}\` exited with code ${exited} before ready`, log);
      if (Date.now() > deadline)
        throw new PreviewError(
          `${readyUrl} not ready after ${preview.readyTimeoutSec}s (${label})`,
          log,
        );
      const ok = await fetch(readyUrl, { redirect: "manual", signal: AbortSignal.timeout(2_000) })
        .then((res) => res.status < 400)
        .catch(() => false);
      if (ok) break;
      options.onProgress?.();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  append(`ready on ${origin}\n`);
  return { url: origin, port, port2, logs: () => log, stop };
}
