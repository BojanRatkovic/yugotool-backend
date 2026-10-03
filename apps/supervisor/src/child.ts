import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type { LogFile } from "./log-file";

export interface ChildSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Sent first (default SIGTERM); SIGKILL follows after `stopTimeoutMs`. */
  stopSignal?: NodeJS.Signals;
  stopTimeoutMs: number;
}

/** One OS process with its output in a log file. */
export class Child {
  private process: ChildProcess | null = null;
  private stopping = false;

  constructor(
    private readonly spec: ChildSpec,
    private readonly log: LogFile,
    /** Called when the process exits without `stop()`. */
    private readonly onCrash: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) {}

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  start(): void {
    this.stopping = false;
    this.log.line(`$ ${this.spec.command} ${this.spec.args.join(" ")}`);
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout?.on("data", (chunk: Buffer) => this.log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.log.write(chunk));
    child.on("error", (error) => this.log.line(`spawn error: ${error.message}`));
    child.on("exit", (code, signal) => {
      this.log.line(`exited (code ${code ?? "-"}, signal ${signal ?? "-"})`);
      if (this.process === child) this.process = null;
      if (!this.stopping) this.onCrash(code, signal);
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    const exited = once(child, "exit");
    child.kill(this.spec.stopSignal ?? "SIGTERM");
    const timer = setTimeout(() => {
      this.log.line(`still running after ${this.spec.stopTimeoutMs} ms, sending SIGKILL`);
      child.kill("SIGKILL");
    }, this.spec.stopTimeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
