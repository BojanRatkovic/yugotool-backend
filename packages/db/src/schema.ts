import type {
  CiStatus,
  Handoff,
  Preview,
  QaStep,
  RouteDiscovery,
  RouteMap,
  Station,
  Verdict,
} from "@zastava/contracts";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  primaryKey,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** How a knowledge source becomes a read-only folder (contracts `knowledgeSourceKindSchema`). */
export const knowledgeSourceKind = pgEnum("knowledge_source_kind", [
  "git_local",
  "git_remote",
  "path",
]);

/** How approved work leaves ZASTAVA (see contracts `deliveryModeSchema`). */
export const deliveryMode = pgEnum("delivery_mode", ["local", "draft_pr", "pr"]);

export const workOrderStatus = pgEnum("work_order_status", [
  "backlog",
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "rejected",
  "cancelled",
]);

export const runStatus = pgEnum("run_status", [
  "running",
  "awaiting_approval",
  "changes_requested",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
]);

export const runEventType = pgEnum("run_event_type", [
  "text",
  "tool_use",
  "tool_result",
  "result",
  "system",
  "error",
  "image",
]);

export const effortLevel = pgEnum("effort_level", ["low", "medium", "high", "xhigh", "max"]);

export const queueMode = pgEnum("queue_mode", ["asap", "night"]);

export const shiftStatus = pgEnum("shift_status", [
  "running",
  "handing_off",
  "awaiting_review",
  "done",
  "failed",
  "cancelled",
]);

export const shiftEndReason = pgEnum("shift_end_reason", [
  "threshold",
  "done",
  "stuck",
  "budget",
  "max_shifts",
  "error",
  "cancelled",
  "manual",
]);

export const qaRunStatus = pgEnum("qa_run_status", ["running", "passed", "failed", "error"]);
export const qaCheckKind = pgEnum("qa_check_kind", ["visual", "scenario", "console", "a11y"]);
export const qaCheckStatus = pgEnum("qa_check_status", [
  "pass",
  "fail",
  "changed",
  "intended",
  "error",
]);
export const findingSeverity = pgEnum("finding_severity", ["critical", "important", "minor"]);

export const authSource = pgEnum("auth_source", ["subscription", "api_key", "unknown"]);

export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  /** How to run the app locally for QA stations; null = not set up. */
  preview: jsonb("preview").$type<Preview>(),
  /** What approving the final gate does by default; each approval can pick another. */
  deliveryDefault: deliveryMode("delivery_default").notNull().default("local"),
  /** The app's screens for QA's planner; null = not discovered yet. */
  routeMap: jsonb("route_map").$type<RouteMap>(),
  /** Outcome of the last route discovery session. */
  routeDiscovery: jsonb("route_discovery").$type<RouteDiscovery>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const lines = pgTable(
  "lines",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    stations: jsonb("stations").$type<Station[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("lines_project_id_idx").on(t.projectId)],
);

export const workOrders = pgTable(
  "work_orders",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: workOrderStatus("status").notNull().default("backlog"),
    stationKey: text("station_key"),
    position: doublePrecision("position").notNull().default(0),
    branch: text("branch"),
    currentRunId: uuid("current_run_id"),
    modelOverride: text("model_override"),
    effortOverride: effortLevel("effort_override"),
    maxBudgetUsd: doublePrecision("max_budget_usd"),
    prUrl: text("pr_url"),
    /** CI on the pull request, as last seen (see CiStatus). */
    ci: jsonb("ci").$type<CiStatus>(),
    queueMode: queueMode("queue_mode"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_orders_project_id_idx").on(t.projectId),
    // The dispatcher's hot query: oldest queued orders first.
    index("work_orders_queued_idx")
      .on(t.queuedAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("running"),
    workflowId: text("workflow_id").notNull(),
    worktreePath: text("worktree_path"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_work_order_id_idx").on(t.workOrderId)],
);

export const stationRuns = pgTable(
  "station_runs",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stationKey: text("station_key").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: runStatus("status").notNull().default("running"),
    sessionId: text("session_id"),
    model: text("model"),
    authSource: authSource("auth_source"),
    output: text("output"),
    verdict: jsonb("verdict").$type<Verdict>(),
    error: text("error"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    contextTokens: integer("context_tokens").notNull().default(0),
    contextWindow: integer("context_window"),
    numTurns: integer("num_turns").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("station_runs_run_id_idx").on(t.runId)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stationRunId: uuid("station_run_id").references(() => stationRuns.id, {
      onDelete: "cascade",
    }),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    type: runEventType("type").notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("run_events_run_id_seq_idx").on(t.runId, t.seq)],
);

/** One Claude session inside a shift station run. */
export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    stationRunId: uuid("station_run_id")
      .notNull()
      .references(() => stationRuns.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    status: shiftStatus("status").notNull().default("running"),
    sessionId: text("session_id"),
    contextTokens: integer("context_tokens").notNull().default(0),
    contextWindow: integer("context_window"),
    handoffAtPct: integer("handoff_at_pct").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    numTurns: integer("num_turns").notNull().default(0),
    commits: integer("commits").notNull().default(0),
    tasksDone: integer("tasks_done").notNull().default(0),
    tasksTotal: integer("tasks_total").notNull().default(0),
    handoff: jsonb("handoff").$type<Handoff>(),
    endReason: shiftEndReason("end_reason"),
    handoffRequested: boolean("handoff_requested").notNull().default(false),
    stopAfter: boolean("stop_after").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("shifts_station_run_id_idx").on(t.stationRunId)],
);

/** One QA attempt: base and PR previews captured, diffed and judged. */
export const qaRuns = pgTable(
  "qa_runs",
  {
    id: id(),
    stationRunId: uuid("station_run_id")
      .notNull()
      .references(() => stationRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: qaRunStatus("status").notNull().default("running"),
    baseSha: text("base_sha"),
    prSha: text("pr_sha"),
    baseUrl: text("base_url"),
    prUrl: text("pr_url"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("qa_runs_station_run_id_idx").on(t.stationRunId)],
);

export const qaChecks = pgTable(
  "qa_checks",
  {
    id: id(),
    qaRunId: uuid("qa_run_id")
      .notNull()
      .references(() => qaRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    name: text("name").notNull(),
    kind: qaCheckKind("kind").notNull(),
    viewport: text("viewport").$type<"desktop" | "mobile">(),
    theme: text("theme").$type<"light" | "dark">(),
    path: text("path"),
    status: qaCheckStatus("status").notNull(),
    diffPct: doublePrecision("diff_pct"),
    /** Paths relative to the run's artifact dir. */
    baseShot: text("base_shot"),
    prShot: text("pr_shot"),
    diffShot: text("diff_shot"),
    steps: jsonb("steps").$type<QaStep[]>().notNull().default([]),
    note: text("note"),
    reason: text("reason"),
    severity: findingSeverity("severity"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [index("qa_checks_qa_run_id_idx").on(t.qaRunId)],
);

/** Single-row table (id = 'default'): this is a one-person local factory. */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("default"),
  maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(2),
  pauseAtFiveHourPct: integer("pause_at_five_hour_pct").notNull().default(85),
  pauseAtWeeklyPct: integer("pause_at_weekly_pct").notNull().default(95),
  nightShiftStart: text("night_shift_start").notNull().default("22:00"),
  nightShiftEnd: text("night_shift_end").notNull().default("07:00"),
  appUrl: text("app_url").notNull().default("http://localhost:4800"),
  desktopNotifications: boolean("desktop_notifications").notNull().default(true),
  slackWebhookUrl: text("slack_webhook_url"),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),
  /** Folder the repo picker scans; null falls back to the REPOS_ROOT env default. */
  reposRoot: text("repos_root"),
  /** Anthropic API key saved in Settings; wins over ANTHROPIC_API_KEY. Never returned by the API. */
  anthropicApiKey: text("anthropic_api_key"),
  updatedAt: updatedAt(),
});

/** Team knowledge planning stations may read (spec 0007). Global library. */
export const knowledgeSources = pgTable("knowledge_sources", {
  id: id(),
  name: text("name").notNull(),
  kind: knowledgeSourceKind("kind").notNull(),
  location: text("location").notNull(),
  branch: text("branch"),
  entryFile: text("entry_file"),
  excludes: jsonb("excludes").$type<string[]>().notNull().default([]),
  lastSyncedSha: text("last_synced_sha"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastEntryFile: text("last_entry_file"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Which sources a project's planning stations read, in order. */
export const projectKnowledge = pgTable(
  "project_knowledge",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Restrict: a source in use is detached from its projects first (409 otherwise).
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceId] }),
    index("project_knowledge_source_id_idx").on(t.sourceId),
  ],
);
