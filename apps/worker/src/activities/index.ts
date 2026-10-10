import { existsSync } from "node:fs";
import path from "node:path";
import { type ApiKeySource, query } from "@anthropic-ai/claude-agent-sdk";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  type AgentStation,
  type AuthSource,
  type ChecksStation,
  type DeliveryMode,
  type Effort,
  EVENTS_CHANNEL,
  type KnowledgeMount,
  type RunEventType,
  type RunStatus,
  REPO_HOOKS_STATION_KEY,
  type ServerEvent,
  type StationRunStatus,
  type Station,
  RESEARCH_PLAN_JSON_SCHEMA,
  researchPlanSchema,
  REVIEW_VERDICT_JSON_SCHEMA,
  type ReviewVerdict,
  runTarget,
  type StationResearch,
  reviewVerdictSchema,
  VERDICT_JSON_SCHEMA,
  type Verdict,
  verdictSchema,
  type WorkOrderStatus,
  type NotificationJob,
} from "@zastava/contracts";
import {
  type Database,
  lines,
  projects,
  runEvents,
  runs,
  shifts,
  stationRuns,
  workOrders,
} from "@zastava/db";
import { enqueueNotification } from "@zastava/notify";
import { and, eq, sql } from "drizzle-orm";
import { runArtifactsDir } from "../runner/artifacts";
import { localRunner } from "../runner/local-runner";
import { runRoots, strayListeners, tcpListeners } from "../runner/orphans";
import { authRejection, withApiKey } from "../claude-env";
import { sandboxFor } from "../runner/sandbox";
import {
  describeSync,
  hubResearchPrompt,
  researchOutput,
  fallbackPlan,
  resolveResearch,
  syncHubRepos,
} from "../runner/hub-research";
import {
  hubOfRepo,
  hubPlugin,
  hubRepoNames,
  hubSession,
  linkIgnoredFiles,
} from "../runner/work-hub";
import { createCiActivities } from "./ci";
import { createKnowledgeActivities } from "./knowledge";
import { createPrBodyComposer } from "./pr-body";
import { createPreviewSignInActivities } from "./preview-sign-in";
import { createQaActivities } from "./qa";
import { createReviewActivities } from "./review";
import { createRouteActivities } from "./routes";
import { createShiftActivities } from "./shifts";

/** The line of a failed git/gh command worth showing: the first error it printed. */
export function deliveryReason(message: string): string {
  const output = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line =
    output.slice(1).find((l) => /error|rejected|denied|fatal|must|not allowed|^[✖✗×]/i.test(l)) ??
    output[0] ??
    "";
  return line.slice(0, 300);
}

/** SGR colour codes (ESC [ … m) that git hooks print. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export type { QaResult } from "./qa";
export type { ReviewRunContext } from "./review";
export type { ShiftResult } from "./shifts";

/** Log lines longer than this are truncated: the board is not a log archive. */
const MAX_EVENT_CHARS = 4_000;

export interface RunContext {
  stations: Station[];
  worktreePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
  modelOverride: string | null;
  effortOverride: Effort | null;
  maxBudgetUsd: number | null;
  /**
   * Hub projects (spec 0014): until the repo is chosen, `worktreePath` is the
   * hub and `branch`/`baseBranch` are empty. Absent on runs started before.
   */
  kind?: "repo" | "hub";
  hubPath?: string | null;
  /** The hub's repos, by name. */
  repos?: string[];
  /** The work order's preset repo; null = Research picks. */
  repo?: string | null;
}

/** A read-only station running in a hub project's hub (spec 0014). */
export interface HubResearchInput {
  hub: string;
  repos: string[];
  presetRepo: string | null;
  /** This station returns the plan (structured: plan, repo, split). */
  plans: boolean;
}

export interface AgentStationResult {
  sessionId: string | null;
  output: string;
  isError: boolean;
  costUsd: number;
  verdict: Verdict | null;
  /** Review stations (structuredVerdict "review", spec 0009). */
  review: ReviewVerdict | null;
  /** The planning station of a hub run (spec 0014). */
  research?: StationResearch | null;
}

export interface ChecksResult {
  passed: boolean;
  output: string;
}

const AUTH_LABEL: Record<AuthSource, string> = {
  subscription: "subscription",
  api_key: "API key",
  unknown: "unknown auth",
};

/** Keys and helpers bill the API; a claude.ai login draws on the subscription. */
function toAuthSource(source: ApiKeySource): AuthSource {
  if (
    source === "ANTHROPIC_API_KEY" ||
    source === "apiKeyHelper" ||
    source === "/login managed key"
  ) {
    return "api_key";
  }
  if (source === "oauth" || source === "none") return "subscription";
  return "unknown";
}

const describeListeners = (list: { port: string; pid: number }[]): string =>
  list.map((l) => `:${l.port} (pid ${l.pid})`).join(", ");

/** Fails the run (not retried) when the repo's commit-msg hook rejects the title. */
async function checkTitle(worktreePath: string, title: string): Promise<void> {
  const message = await localRunner.checkCommitMessage(worktreePath, title).catch(() => null);
  if (!message || message.passed) return;
  const why = message.output.replace(ANSI_COLOR, "");
  // A hook that can't run yet (its tool isn't installed before `npm ci`) is not a verdict.
  if (/command not found|not found|ENOENT|Cannot find module/i.test(why)) return;
  const first =
    why
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "rejected";
  throw ApplicationFailure.nonRetryable(
    `Work order title rejected by the repo's commit-msg hook: ${first}. Rename the work order and run it again.`,
  );
}

export function createActivities(db: Database) {
  async function notify(event: ServerEvent): Promise<void> {
    await db.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`);
  }

  async function invalidateBoard(): Promise<void> {
    await notify({ type: "invalidate", collection: "work_orders" });
    await notify({ type: "invalidate", collection: "runs" });
  }

  async function appendEvent(
    runId: string,
    stationRunId: string | null,
    type: RunEventType,
    message: string,
  ): Promise<void> {
    const [row] = await db
      .insert(runEvents)
      .values({ runId, stationRunId, type, message: message.slice(0, MAX_EVENT_CHARS) })
      .returning({ seq: runEvents.seq });
    if (row) await notify({ type: "run_event", runId, seq: row.seq });
  }

  /**
   * Queues a notification (spec 0011); the API's job processor renders, stores
   * and fans it out. Idempotent on `dedupeKey`, so a retried activity queues once.
   */
  async function notifyHumans(job: NotificationJob, dedupeKey: string): Promise<void> {
    await enqueueNotification(db, job, dedupeKey);
  }

  const composePrBody = createPrBodyComposer(db);

  async function isReview(workOrderId: string): Promise<boolean> {
    const [row] = await db
      .select({ kind: workOrders.kind })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId));
    return row?.kind === "review";
  }

  /**
   * Agent stations are told to commit nothing, but builders commit anyway —
   * often with `--no-verify`, which would leave the preflight hook an empty
   * stage and ship their message instead of the work order title. Commits made
   * during the session become working-tree changes again. (Shift checkpoints
   * are ZASTAVA's own and stay.)
   */
  async function uncommitAfter<T>(
    input: { runId: string; stationRunId: string; worktreePath: string },
    session: () => Promise<T>,
  ): Promise<T> {
    const start = await localRunner.headSha(input.worktreePath);
    try {
      return await session();
    } finally {
      const undone = await localRunner.uncommitSince(input.worktreePath, start).catch(() => 0);
      if (undone) {
        await appendEvent(
          input.runId,
          input.stationRunId,
          "system",
          `Undid ${undone} commit${undone === 1 ? "" : "s"} the agent made: the changes stay in the worktree and are committed once, under the work order title, at delivery.`,
        );
      }
    }
  }

  /**
   * Agents start dev servers with `&` and walk away; the Bash sandbox allows
   * binding local ports, so those outlive the session. After every agent/shift
   * session, stop new listeners that run from the worktree or the main checkout.
   */
  async function sweepAfter<T>(
    input: { runId: string; stationRunId: string; worktreePath: string },
    session: () => Promise<T>,
  ): Promise<T> {
    const before = new Set((await tcpListeners().catch(() => [])).map((l) => l.pid));
    try {
      return await session();
    } finally {
      try {
        const [worktree, checkout] = await runRoots(input.worktreePath);
        const after = await tcpListeners();
        // Only worktree processes are ours to stop; one in the main checkout may be the user's own dev server.
        const strays = worktree ? strayListeners(before, after, [worktree]) : [];
        for (const stray of strays) {
          try {
            process.kill(stray.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
        if (strays.length) {
          await appendEvent(
            input.runId,
            input.stationRunId,
            "system",
            `Stopped ${strays.length} server${strays.length === 1 ? "" : "s"} the agent left running: ${describeListeners(strays)}`,
          );
        }
        const [row] = await db
          .select({ project: projects, runRepo: runs.repo })
          .from(runs)
          .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
          .innerJoin(projects, eq(projects.id, workOrders.projectId))
          .where(eq(runs.id, input.runId));
        if (row) {
          const { baseBranch } = runTarget(row.project, row.runRepo);
          const baseSha = await localRunner.mergeBase(input.worktreePath, baseBranch);
          const reverted = await localRunner.revertIncidentalLockfiles(input.worktreePath, baseSha);
          if (reverted.length) {
            await appendEvent(
              input.runId,
              input.stationRunId,
              "system",
              `Restored ${reverted.join(", ")}: the agent changed ${reverted.length === 1 ? "it" : "them"} without changing any package.json (a stray install rewrites lockfiles and breaks \`npm ci\`).`,
            );
          }
        }
        const outside = checkout ? strayListeners(before, after, [checkout]) : [];
        if (outside.length) {
          await appendEvent(
            input.runId,
            input.stationRunId,
            "error",
            `New server${outside.length === 1 ? "" : "s"} running from the main checkout (${checkout}), possibly started by the agent: ${describeListeners(outside)}. Not stopped automatically.`,
          );
        }
      } catch {
        // Best effort: a failed sweep must not fail the station.
      }
    }
  }

  const activities = {
    ...createShiftActivities(db, { appendEvent, notify, invalidateBoard, notifyHumans }),
    ...createQaActivities(db, { appendEvent, notify }),
    ...createRouteActivities(db, { notify }),
    ...createPreviewSignInActivities(db, { notify }),
    ...createCiActivities(db, { appendEvent, invalidateBoard, notifyHumans }),
    ...createKnowledgeActivities(db, { appendEvent, notify, notifyHumans }),
    ...createReviewActivities(db, { appendEvent, invalidateBoard, notify, notifyHumans }),

    async prepareRun(input: { runId: string; workOrderId: string }): Promise<RunContext> {
      const [row] = await db
        .select({ workOrder: workOrders, project: projects, line: lines })
        .from(workOrders)
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .innerJoin(lines, and(eq(lines.projectId, projects.id), eq(lines.kind, "build")))
        .where(eq(workOrders.id, input.workOrderId));
      if (!row) throw new Error(`work order ${input.workOrderId} not found`);

      // A hub project (spec 0014): Research runs in the hub; the worktree comes
      // once the repo is chosen (prepareRepoWorkspace).
      if (row.project.kind === "hub") {
        const hub = row.project.repoPath;
        const repos = hubRepoNames(hub);
        const repoSettings = row.project.repoSettings ?? {};
        await appendEvent(
          input.runId,
          null,
          "system",
          `Work hub ${hub}: planning runs in the hub, read-only${row.workOrder.repo ? ` · repo ${row.workOrder.repo}` : " · Research picks the repo"}`,
        );
        const synced = await syncHubRepos(
          hub,
          repos.map((name) => ({ name, baseBranch: repoSettings[name]?.baseBranch ?? "main" })),
        );
        if (synced.length) await appendEvent(input.runId, null, "system", describeSync(synced));
        await invalidateBoard();
        return {
          stations: row.line.stations,
          worktreePath: hub,
          branch: "",
          baseBranch: "",
          title: row.workOrder.title,
          description: row.workOrder.description,
          modelOverride: row.workOrder.modelOverride,
          effortOverride: row.workOrder.effortOverride,
          maxBudgetUsd: row.workOrder.maxBudgetUsd,
          kind: "hub",
          hubPath: hub,
          repos,
          repo: row.workOrder.repo,
        };
      }

      const hub = hubOfRepo(row.project.repoPath);
      const workspace = await localRunner.prepareWorkspace({
        repoPath: row.project.repoPath,
        baseBranch: row.project.baseBranch,
        runId: input.runId,
        title: row.workOrder.title,
        hub,
      });
      await db.update(runs).set({ worktreePath: workspace.path }).where(eq(runs.id, input.runId));
      await db
        .update(workOrders)
        .set({ branch: workspace.branch })
        .where(eq(workOrders.id, input.workOrderId));
      await appendEvent(
        input.runId,
        null,
        "system",
        // The worktree path is in the panel's Details rail.
        `Workspace ready on branch ${workspace.branch}`,
      );
      if (hub) {
        const linked = await linkIgnoredFiles(row.project.repoPath, workspace.path).catch(() => []);
        const plugin = await hubPlugin(hub).catch(() => null);
        await appendEvent(
          input.runId,
          null,
          "system",
          [
            `Work hub ${hub}: worktree in its worktrees/, hub CLAUDE.md/AGENTS.md and knowledge readable`,
            plugin ? `skills ${plugin.skills.join(", ")}` : null,
            linked.length ? `linked ignored files ${linked.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        );
      }
      await invalidateBoard();

      // A commit-msg rule (Conventional Commits…) rejects the work order title
      // only at delivery, after every station ran — and no agent can fix a
      // title. Check it before spending anything.
      await checkTitle(workspace.path, row.workOrder.title);

      return {
        stations: row.line.stations,
        worktreePath: workspace.path,
        branch: workspace.branch,
        baseBranch: row.project.baseBranch,
        title: row.workOrder.title,
        description: row.workOrder.description,
        modelOverride: row.workOrder.modelOverride,
        effortOverride: row.workOrder.effortOverride,
        maxBudgetUsd: row.workOrder.maxBudgetUsd,
      };
    },

    /**
     * A hub run's worktree, once its repo is chosen (spec 0014): made as for a
     * hub repo project (0012) in `<hub>/worktrees/`, off the repo's base branch.
     * From here the run is a normal run on that repo.
     */
    async prepareRepoWorkspace(input: {
      runId: string;
      workOrderId: string;
      hub: string;
      repo: string;
    }): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
      const [row] = await db
        .select({ workOrder: workOrders, project: projects, run: runs })
        .from(runs)
        .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .where(eq(runs.id, input.runId));
      if (!row) throw new Error(`run ${input.runId} not found`);
      const repoPath = path.join(input.hub, "repos", input.repo);
      if (!existsSync(path.join(repoPath, ".git"))) {
        throw ApplicationFailure.nonRetryable(
          `${input.repo} is not a repo of the hub ${input.hub}`,
        );
      }
      const baseBranch = row.project.repoSettings?.[input.repo]?.baseBranch ?? "main";
      // A retried activity finds the worktree it already made.
      const existing = row.run.worktreePath !== input.hub ? row.run.worktreePath : null;
      if (existing && row.run.repo === input.repo && row.workOrder.branch && existsSync(existing)) {
        return { worktreePath: existing, branch: row.workOrder.branch, baseBranch };
      }
      const workspace = await localRunner.prepareWorkspace({
        repoPath,
        baseBranch,
        runId: input.runId,
        title: row.workOrder.title,
        hub: input.hub,
      });
      await db
        .update(runs)
        .set({ worktreePath: workspace.path, repo: input.repo })
        .where(eq(runs.id, input.runId));
      await db
        .update(workOrders)
        .set({ branch: workspace.branch, repo: input.repo })
        .where(eq(workOrders.id, input.workOrderId));
      await appendEvent(
        input.runId,
        null,
        "system",
        `Workspace ready for ${input.repo} on branch ${workspace.branch} (from ${baseBranch})`,
      );
      const linked = await linkIgnoredFiles(repoPath, workspace.path).catch(() => []);
      const plugin = await hubPlugin(input.hub).catch(() => null);
      await appendEvent(
        input.runId,
        null,
        "system",
        [
          `Work hub ${input.hub}: worktree in its worktrees/, hub CLAUDE.md/AGENTS.md and knowledge readable`,
          plugin ? `skills ${plugin.skills.join(", ")}` : null,
          linked.length ? `linked ignored files ${linked.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      await invalidateBoard();
      await checkTitle(workspace.path, row.workOrder.title);
      return { worktreePath: workspace.path, branch: workspace.branch, baseBranch };
    },

    async beginStation(input: {
      runId: string;
      workOrderId: string;
      stationKey: string;
      attempt: number;
      status: "running" | "awaiting_approval";
    }): Promise<string> {
      const [stationRun] = await db
        .insert(stationRuns)
        .values({
          runId: input.runId,
          stationKey: input.stationKey,
          attempt: input.attempt,
          status: input.status,
        })
        .returning({ id: stationRuns.id });
      if (!stationRun) throw new Error("station run insert returned nothing");
      await db.update(runs).set({ status: input.status }).where(eq(runs.id, input.runId));
      await db
        .update(workOrders)
        .set({ stationKey: input.stationKey, status: input.status })
        .where(eq(workOrders.id, input.workOrderId));
      await invalidateBoard();
      if (input.status === "awaiting_approval") {
        await notifyHumans(
          {
            kind: "gate_waiting",
            payload: { workOrderId: input.workOrderId, stationKey: input.stationKey },
          },
          `gate_waiting:${stationRun.id}`,
        );
      }
      return stationRun.id;
    },

    async finishStation(input: {
      runId: string;
      stationRunId: string;
      status: StationRunStatus;
      output?: string;
      error?: string;
      /** Gate comments are logged; agent output already streamed as events. */
      log?: boolean;
    }): Promise<void> {
      await db
        .update(stationRuns)
        .set({
          status: input.status,
          output: input.output ?? null,
          error: input.error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(stationRuns.id, input.stationRunId));
      if (input.log && input.output)
        await appendEvent(input.runId, input.stationRunId, "system", input.output);
      await invalidateBoard();
    },

    /**
     * After the run ends: unfinished changes are committed to its branch, the
     * shift memory copied to artifacts, and the worktree removed (each one
     * holds its own node_modules). Failures are logged, never fatal.
     */
    async archiveRun(input: { runId: string }): Promise<void> {
      const [row] = await db
        .select({
          worktreePath: runs.worktreePath,
          status: runs.status,
          runRepo: runs.repo,
          project: projects,
        })
        .from(runs)
        .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .where(eq(runs.id, input.runId));
      if (!row?.worktreePath) return;
      try {
        const snapshot = await localRunner.archiveWorkspace({
          repoPath: runTarget(row.project, row.runRepo).repoPath,
          worktreePath: row.worktreePath,
          memoryDir: path.join(runArtifactsDir(input.runId), "memory"),
          message: `wip: unfinished changes of ZASTAVA run ${input.runId.slice(0, 8)} (${row.status})`,
        });
        await appendEvent(
          input.runId,
          null,
          "system",
          snapshot
            ? `Worktree removed; unfinished changes kept on the branch (${snapshot})`
            : "Worktree removed; the branch keeps the work",
        );
      } catch (error) {
        await appendEvent(
          input.runId,
          null,
          "system",
          `Could not remove the worktree: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async finishRun(input: {
      runId: string;
      workOrderId: string;
      status: RunStatus;
      reason?: string;
    }): Promise<void> {
      const workOrderStatus: WorkOrderStatus =
        input.status === "succeeded"
          ? "done"
          : input.status === "running" || input.status === "awaiting_approval"
            ? "failed"
            : input.status;
      await db
        .update(runs)
        .set({ status: input.status, finishedAt: new Date() })
        .where(eq(runs.id, input.runId));
      await db
        .update(workOrders)
        .set({
          status: workOrderStatus,
          ...(workOrderStatus === "done" ? { stationKey: null } : {}),
        })
        .where(eq(workOrders.id, input.workOrderId));
      // Rows still running belong to the station that was interrupted.
      const interrupted = await db
        .update(stationRuns)
        .set({
          status: input.status === "succeeded" ? "failed" : input.status,
          finishedAt: new Date(),
        })
        .where(
          sql`${stationRuns.runId} = ${input.runId} AND ${stationRuns.status} IN ('running', 'awaiting_approval')`,
        )
        .returning({ id: stationRuns.id });
      // Same for a shift whose activity was still unwinding when the run ended.
      await db
        .update(shifts)
        .set({
          status: input.status === "cancelled" ? "cancelled" : "failed",
          endReason: input.status === "cancelled" ? "cancelled" : "error",
          finishedAt: new Date(),
        })
        .where(
          sql`${shifts.status} IN ('running', 'handing_off', 'awaiting_review') AND ${shifts.stationRunId} IN (SELECT ${stationRuns.id} FROM ${stationRuns} WHERE ${stationRuns.runId} = ${input.runId})`,
        );
      await notify({ type: "invalidate", collection: "shifts" });
      if (input.reason)
        await appendEvent(
          input.runId,
          // A cancel belongs to the station it stopped, so Activity keeps that group whole.
          input.status === "cancelled" && interrupted.length === 1 ? interrupted[0]!.id : null,
          input.status === "cancelled" ? "system" : "error",
          input.reason,
        );
      await invalidateBoard();
      if (input.status === "failed") {
        await notifyHumans(
          {
            kind: "run_failed",
            payload: { workOrderId: input.workOrderId, reason: input.reason ?? null },
          },
          `run_finished:${input.runId}`,
        );
      } else if (input.status === "succeeded" && !(await isReview(input.workOrderId))) {
        // A finished review notifies from completeReview, with its findings.
        await notifyHumans(
          { kind: "run_succeeded", payload: { workOrderId: input.workOrderId } },
          `run_finished:${input.runId}`,
        );
      }
    },

    /**
     * Runs one agent station as a Claude Code session in the run's worktree.
     * Heartbeats on every message so a cancelled run aborts the session.
     */
    async runAgentStation(input: {
      runId: string;
      stationRunId: string;
      station: AgentStation;
      worktreePath: string;
      prompt: string;
      modelOverride: string | null;
      effortOverride: Effort | null;
      /** Continue an earlier session of this station (same worktree) instead of starting fresh. */
      resumeSessionId?: string | null;
      /** Planning stations: the project's knowledge folders, readable but not writable. */
      knowledge?: KnowledgeMount[];
      /** A read-only station of a hub run, in the hub itself (`worktreePath` = the hub). */
      hubResearch?: HubResearchInput;
    }): Promise<AgentStationResult> {
      const model = input.modelOverride ?? input.station.model;
      const effort = input.effortOverride ?? input.station.effort;
      const ctx = Context.current();
      const abortController = new AbortController();
      ctx.cancellationSignal.addEventListener("abort", () => abortController.abort());

      const research = input.hubResearch ?? null;
      // In the hub the project settings load its own skills; a hub worktree gets them as a plugin.
      const hub = research
        ? { readRoots: [], plugins: [], tools: ["Skill"], prompt: hubResearchPrompt(research) }
        : await hubSession(input.worktreePath);
      const readRoots = [...(input.knowledge ?? []).map((k) => k.dir), ...(hub?.readRoots ?? [])];
      const tools = [...input.station.allowedTools, ...(hub?.tools ?? [])];
      const sandboxed = await withApiKey(
        await sandboxFor(input.worktreePath, { readRoots, readOnly: research !== null }),
      );
      const outputSchema = research?.plans
        ? RESEARCH_PLAN_JSON_SCHEMA
        : input.station.structuredVerdict === "review"
          ? REVIEW_VERDICT_JSON_SCHEMA
          : input.station.structuredVerdict
            ? VERDICT_JSON_SCHEMA
            : null;
      const session = query({
        prompt: input.prompt,
        options: {
          cwd: input.worktreePath,
          model,
          ...(effort ? { effort } : {}),
          ...(input.station.maxBudgetUsd ? { maxBudgetUsd: input.station.maxBudgetUsd } : {}),
          ...(outputSchema
            ? { outputFormat: { type: "json_schema" as const, schema: outputSchema } }
            : {}),
          tools,
          allowedTools: tools,
          // Without it Read outside cwd needs a permission dontAsk never grants (QA does the same).
          ...(readRoots.length > 0 ? { additionalDirectories: readRoots } : {}),
          ...(hub?.plugins.length ? { plugins: hub.plugins } : {}),
          permissionMode: "dontAsk",
          ...sandboxed,
          settingSources: ["project"],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: hub ? `${input.station.prompt}\n\n${hub.prompt}` : input.station.prompt,
          },
          abortController,
          ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
          maxTurns: 60,
        },
      });

      let output = "";
      let sessionId: string | null = null;
      let isError = false;
      let costUsd = 0;
      let verdict: Verdict | null = null;
      let review: ReviewVerdict | null = null;
      let plan: StationResearch | null = null;
      /** Hub planning: every text the session wrote, for a plan without a structured answer. */
      const texts: string[] = [];
      /** Context size = everything the model read on its latest top-level turn. */
      let contextTokens = 0;
      for await (const message of session) {
        ctx.heartbeat();
        const rejected = authRejection(message);
        if (rejected) {
          isError = true;
          output = rejected;
          await appendEvent(input.runId, input.stationRunId, "system", rejected);
          abortController.abort();
          break;
        }
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          await db
            .update(stationRuns)
            .set({
              sessionId: message.session_id,
              model: message.model,
              authSource: toAuthSource(message.apiKeySource),
            })
            .where(eq(stationRuns.id, input.stationRunId));
          await appendEvent(
            input.runId,
            input.stationRunId,
            "system",
            `${input.resumeSessionId ? "Resumed session" : "Session"} ${message.session_id} · ${message.model}${effort ? ` · effort ${effort}` : ""} · ${AUTH_LABEL[toAuthSource(message.apiKeySource)]}`,
          );
        } else if (message.type === "assistant") {
          const usage = message.message.usage;
          if (message.parent_tool_use_id === null && usage) {
            contextTokens =
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
          }
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              if (research?.plans && message.parent_tool_use_id === null) texts.push(block.text);
              await appendEvent(input.runId, input.stationRunId, "text", block.text);
            } else if (block.type === "tool_use") {
              await appendEvent(
                input.runId,
                input.stationRunId,
                "tool_use",
                `${block.name} ${JSON.stringify(block.input)}`,
              );
            }
          }
        } else if (message.type === "result") {
          isError = message.is_error;
          costUsd = message.total_cost_usd;
          output =
            message.subtype === "success" ? message.result : `Station ended: ${message.subtype}`;
          if (research?.plans && message.subtype === "success") {
            // No structured answer: the plan is the text, the repo the first one it names.
            const parsed = researchPlanSchema.safeParse(message.structured_output);
            plan = resolveResearch(
              parsed.success
                ? parsed.data
                : { plan: fallbackPlan(texts, message.result), repo: "" },
              research.repos,
              research.presetRepo,
            );
            output = researchOutput(plan);
          } else if (message.subtype === "success" && message.structured_output !== undefined) {
            if (input.station.structuredVerdict === "review") {
              const parsed = reviewVerdictSchema.safeParse(message.structured_output);
              review = parsed.success ? parsed.data : null;
              if (review) {
                output = `${review.recommendation.toUpperCase().replace("_", " ")}: ${review.summary} (${review.findings.length} finding${review.findings.length === 1 ? "" : "s"})`;
              }
            } else {
              const parsed = verdictSchema.safeParse(message.structured_output);
              verdict = parsed.success ? parsed.data : null;
              if (verdict) output = `${verdict.verdict.toUpperCase()}: ${verdict.summary}`;
            }
          }
          await db
            .update(stationRuns)
            .set({
              costUsd: message.total_cost_usd,
              verdict,
              review,
              ...(research?.plans ? { research: plan } : {}),
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              cacheReadTokens: message.usage.cache_read_input_tokens,
              numTurns: message.num_turns,
              contextTokens,
              contextWindow:
                message.modelUsage[model]?.contextWindow ??
                Object.values(message.modelUsage)[0]?.contextWindow ??
                null,
            })
            .where(eq(stationRuns.id, input.stationRunId));
          await appendEvent(
            input.runId,
            input.stationRunId,
            "result",
            `${message.subtype} · ${message.num_turns} turns · $${message.total_cost_usd.toFixed(4)}`,
          );
        }
      }
      if (input.station.canEdit) {
        const stat = await localRunner.diffStat(input.worktreePath);
        if (stat) await appendEvent(input.runId, input.stationRunId, "system", `Changes:\n${stat}`);
      }
      return { sessionId, output, isError, costUsd, verdict, review, research: plan };
    },

    /** Runs the station's shell command in the worktree; non-zero exit = failed. */
    async runChecks(input: {
      runId: string;
      stationRunId: string;
      station: ChecksStation;
      worktreePath: string;
    }): Promise<ChecksResult> {
      await appendEvent(input.runId, input.stationRunId, "tool_use", `$ ${input.station.command}`);
      const result = await localRunner.runCommand(input.worktreePath, input.station.command, () =>
        Context.current().heartbeat(),
      );
      const tail = result.output.slice(-MAX_EVENT_CHARS);
      await appendEvent(
        input.runId,
        input.stationRunId,
        result.passed ? "tool_result" : "error",
        tail || "(no output)",
      );
      return { passed: result.passed, output: tail };
    },

    /**
     * Delivery preflight, before the final gate: the repo's pre-commit hook over
     * the run's changes, so a hook that would block the commit sends the work
     * back to the builder instead of failing after approval.
     */
    async repoHooks(input: {
      runId: string;
      worktreePath: string;
      attempt: number;
    }): Promise<{ ran: boolean; passed: boolean; output: string }> {
      let stationRunId: string | null = null;
      const result = await localRunner.runPreCommitHook(
        input.worktreePath,
        () => Context.current().heartbeat(),
        async () => {
          // Recorded as its own step (drawn before the final gate) only when there is a hook.
          const [row] = await db
            .insert(stationRuns)
            .values({
              runId: input.runId,
              stationKey: REPO_HOOKS_STATION_KEY,
              attempt: input.attempt,
              status: "running",
            })
            .returning({ id: stationRuns.id });
          stationRunId = row?.id ?? null;
          await invalidateBoard();
          await appendEvent(input.runId, stationRunId, "tool_use", "$ git hook run pre-commit");
        },
      );
      if (!result) return { ran: false, passed: true, output: "" };
      const output = result.output.replace(ANSI_COLOR, "").slice(-MAX_EVENT_CHARS);
      if (output.trim())
        await appendEvent(
          input.runId,
          stationRunId,
          result.passed ? "tool_result" : "error",
          output.trim(),
        );
      const summary = result.passed
        ? "Repo pre-commit hook passed: delivery will commit cleanly."
        : "Repo pre-commit hook failed: the commit would be blocked. Sent back to the builder.";
      await appendEvent(input.runId, stationRunId, result.passed ? "system" : "error", summary);
      if (stationRunId) {
        await db
          .update(stationRuns)
          .set({
            status: result.passed ? "succeeded" : "failed",
            output: summary,
            finishedAt: new Date(),
          })
          .where(eq(stationRuns.id, stationRunId));
      }
      await invalidateBoard();
      return { ran: true, passed: result.passed, output };
    },

    /**
     * After final approval: commit the worktree, push and open a PR when the
     * repo has an origin (commit only when the project is local only). A
     * failure fails the run, with the reason; the work stays on its branch.
     */
    async deliver(input: {
      runId: string;
      workOrderId: string;
      worktreePath: string;
      branch: string;
      baseBranch: string;
      title: string;
      /** Chosen at the final gate; omitted = the project's local-only / draft settings. */
      delivery?: DeliveryMode;
    }): Promise<{ ok: boolean; error: string | null; prUrl?: string | null }> {
      let outcome: { ok: boolean; error: string | null; prUrl?: string | null } = {
        ok: true,
        error: null,
      };
      try {
        const [project] = await db
          .select({ deliveryDefault: projects.deliveryDefault })
          .from(workOrders)
          .innerJoin(projects, eq(projects.id, workOrders.projectId))
          .where(eq(workOrders.id, input.workOrderId));
        const mode: DeliveryMode = input.delivery ?? project?.deliveryDefault ?? "local";
        const localOnly = mode === "local";
        const draft = mode === "draft_pr";
        const body = localOnly ? "" : await composePrBody(input);
        const result = await localRunner.deliver({ ...input, body, localOnly, draft });
        outcome.prUrl = result.prUrl;
        if (result.prUrl) {
          await db
            .update(workOrders)
            .set({ prUrl: result.prUrl })
            .where(eq(workOrders.id, input.workOrderId));
        }
        await appendEvent(input.runId, null, "system", result.summary);
      } catch (error) {
        // Repo hooks (lefthook, husky) print coloured boxes; keep the text only.
        const message = (error instanceof Error ? error.message : String(error)).replace(
          ANSI_COLOR,
          "",
        );
        await appendEvent(input.runId, null, "error", `Delivery failed: ${message}`);
        outcome = {
          ok: false,
          error: `Delivery failed (work is safe on ${input.branch}): ${deliveryReason(message)}`,
        };
      }
      await invalidateBoard();
      return outcome;
    },

    /**
     * For work delivered locally: push its branch and open a PR (from the
     * run's worktree, or the repo once that is gone). The result lands on the
     * work order and in the run's Activity.
     */
    async openPullRequest(input: {
      workOrderId: string;
      draft: boolean;
    }): Promise<{ prUrl: string | null; error: string | null }> {
      const [row] = await db
        .select({
          title: workOrders.title,
          branch: workOrders.branch,
          runId: workOrders.currentRunId,
          project: projects,
          runRepo: runs.repo,
          worktreePath: runs.worktreePath,
        })
        .from(workOrders)
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .leftJoin(runs, eq(runs.id, workOrders.currentRunId))
        .where(eq(workOrders.id, input.workOrderId));
      if (!row?.branch || !row.runId) {
        return { prUrl: null, error: "This work order has no delivered branch." };
      }
      // A hub run delivers from its repo (spec 0014); a repo run from the project's.
      const { repoPath, baseBranch } = runTarget(row.project, row.runRepo);
      const dir = row.worktreePath && existsSync(row.worktreePath) ? row.worktreePath : repoPath;
      try {
        const body = await composePrBody({
          runId: row.runId,
          workOrderId: input.workOrderId,
          worktreePath: dir,
          baseBranch,
        });
        const result = await localRunner.openPullRequest({
          dir,
          branch: row.branch,
          baseBranch,
          title: row.title,
          body,
          draft: input.draft,
        });
        if (!result.prUrl) {
          const reason = result.reason ?? result.summary;
          await appendEvent(row.runId, null, "error", `Pull request not opened: ${reason}`);
          return { prUrl: null, error: reason };
        }
        await appendEvent(row.runId, null, "system", result.summary);
        await db
          .update(workOrders)
          .set({ prUrl: result.prUrl })
          .where(eq(workOrders.id, input.workOrderId));
        return { prUrl: result.prUrl, error: null };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(
          ANSI_COLOR,
          "",
        );
        await appendEvent(row.runId, null, "error", `Pull request failed: ${message}`);
        return { prUrl: null, error: `Pull request failed: ${deliveryReason(message)}` };
      } finally {
        await invalidateBoard();
      }
    },
  };

  return {
    ...activities,
    runAgentStation: (input: Parameters<typeof activities.runAgentStation>[0]) =>
      // In the hub itself nothing is ours to sweep or uncommit: the hub, its
      // repos and their servers are the person's (spec 0014).
      input.hubResearch
        ? activities.runAgentStation(input)
        : sweepAfter(input, () => uncommitAfter(input, () => activities.runAgentStation(input))),
    runShift: (input: Parameters<typeof activities.runShift>[0]) =>
      sweepAfter(input, () => activities.runShift(input)),
  };
}

export type Activities = ReturnType<typeof createActivities>;
