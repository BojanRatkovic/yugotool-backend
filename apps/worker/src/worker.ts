import { existsSync } from "node:fs";
import path from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { TASK_QUEUE } from "@zastava/contracts";
import { createDbClient } from "@zastava/db";
import { z } from "zod";
import { createActivities } from "./activities";
import { readApiKeyFrom } from "./claude-env";

// The worker's single process.env read, validated with defaults for local dev.
const envSchema = z.object({
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  DATABASE_URL: z.string().default("postgres://localhost:5432/zastava"),
});

const PREBUILT_BUNDLE = path.join(__dirname, "workflow-bundle.js");

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  // Inside the desktop app this process is Electron running as Node; previews
  // and agent sessions it spawns must not inherit that (an Electron repo's
  // preview would start as plain Node).
  delete process.env["ELECTRON_RUN_AS_NODE"];
  const dbClient = createDbClient(env.DATABASE_URL);
  readApiKeyFrom(dbClient.db);
  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });

  try {
    const worker = await Worker.create({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: TASK_QUEUE,
      // The desktop app ships a prebuilt bundle (scripts/bundle-workflows.mjs); dev bundles at start.
      ...(existsSync(PREBUILT_BUNDLE)
        ? { workflowBundle: { codePath: PREBUILT_BUNDLE } }
        : { workflowsPath: require.resolve("./workflows") }),
      activities: createActivities(dbClient.db),
      // Activities learn about a cancel only when a heartbeat reaches the
      // server; the default throttle (up to 60 s) let agents keep editing
      // after "Cancel run". Sessions heartbeat per message, so this is cheap.
      defaultHeartbeatThrottleInterval: "2 seconds",
      maxHeartbeatThrottleInterval: "5 seconds",
    });
    const shutdown = (): void => worker.shutdown();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    await worker.run();
  } finally {
    await connection.close();
    await dbClient.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("worker crashed", error);
  process.exitCode = 1;
});
