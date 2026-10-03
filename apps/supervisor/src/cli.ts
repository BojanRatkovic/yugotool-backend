#!/usr/bin/env node
import { loadConfig } from "./config";
import { pidAlive, readStatus, Supervisor, type SupervisorStatus } from "./supervisor";

const USAGE = `Usage: zastava <command>

  start    Start Postgres, migrations, Temporal, API and worker; Ctrl-C stops them
  status   Show what a running supervisor reports
  stop     Ask a running supervisor to stop everything

Environment: ZASTAVA_HOME (default ~/.zastava), ZASTAVA_API_PORT (4810),
ZASTAVA_PG_PORT (4832), ZASTAVA_TEMPORAL_PORT (4833), ZASTAVA_TEMPORAL_UI_PORT (4834).`;

async function main(): Promise<void> {
  const config = loadConfig();
  switch (process.argv[2]) {
    case "start":
      return start();
    case "status": {
      const status = readStatus(config.stateFile);
      if (!status || !pidAlive(status.pid)) {
        console.log(`Not running (${config.home}).`);
        process.exitCode = 1;
        return;
      }
      print(status);
      return;
    }
    case "stop": {
      const status = readStatus(config.stateFile);
      if (!status || !pidAlive(status.pid)) {
        console.log("Not running.");
        return;
      }
      process.kill(status.pid, "SIGTERM");
      while (pidAlive(status.pid)) await new Promise((r) => setTimeout(r, 200));
      console.log("Stopped.");
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = process.argv[2] ? 1 : 0;
  }

  async function start(): Promise<void> {
    const supervisor = new Supervisor(config);
    supervisor.on("status", (s) => {
      const changed = s.services.map((x) => `${x.name}:${x.state}`).join("  ");
      console.log(`${new Date().toLocaleTimeString()}  ${changed}`);
    });
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping…`);
      void supervisor.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    try {
      await supervisor.start();
    } catch (error) {
      console.error(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    print(supervisor.snapshot());
    console.log(`\nZASTAVA is running at ${supervisor.appUrl}  (logs: ${config.logsDir})`);
  }
}

function print(status: SupervisorStatus): void {
  for (const s of status.services) {
    const pid = s.pid ? `pid ${s.pid}` : "";
    const port = s.port ? `:${s.port}` : "";
    console.log(
      `${s.name.padEnd(11)} ${s.state.padEnd(10)} ${port.padEnd(7)} ${pid.padEnd(10)} ${s.detail ?? ""}`,
    );
  }
}

void main();
