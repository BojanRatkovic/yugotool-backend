import { z } from "zod";

/** Temporal task queue shared by the API (client) and the worker. */
export const TASK_QUEUE = "zastava";
/** Signal name the workflow listens on for gate decisions. */
export const GATE_DECISION_SIGNAL = "gateDecision";
/** Signal for shift stations: stop after the current shift, or a handoff review decision. */
export const SHIFT_CONTROL_SIGNAL = "shiftControl";
/** Postgres NOTIFY channel the worker publishes to and the API fans out over SSE. */
export const EVENTS_CHANNEL = "zastava_events";

const isoDate = z.iso.datetime({ offset: true });

// ── Models ──────────────────────────────────────────────────────────────────

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;

/** Where the agent's credentials came from: a claude.ai login or an API key. */
export const authSourceSchema = z.enum(["subscription", "api_key", "unknown"]);
export type AuthSource = z.infer<typeof authSourceSchema>;

// ── Line ────────────────────────────────────────────────────────────────────

const stationKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const agentStationSchema = z.object({
  key: stationKeySchema,
  kind: z.literal("agent"),
  name: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  effort: effortSchema.optional(),
  /** Hard stop for one session; the SDK aborts with error_max_budget_usd. */
  maxBudgetUsd: z.number().positive().optional(),
  allowedTools: z.array(z.string()),
  canEdit: z.boolean(),
  /** Validator stations return a structured verdict (JSON schema output). */
  structuredVerdict: z.boolean().optional(),
  prompt: z.string(),
});

export const gateStationSchema = z.object({
  key: stationKeySchema,
  kind: z.literal("gate"),
  name: z.string(),
  prompt: z.string(),
});

/** Runs a shell command in the worktree (tests, lint). Failure loops back to the builder. */
export const checksStationSchema = z.object({
  key: stationKeySchema,
  kind: z.literal("checks"),
  name: z.string().min(1),
  command: z.string().min(1),
});

/**
 * A long-running station that works in shifts: when a session's context crosses
 * `handoffAtPct`, it writes a structured handoff and a fresh session continues.
 */
export const shiftStationSchema = z.object({
  key: stationKeySchema,
  kind: z.literal("shift"),
  name: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  effort: effortSchema.optional(),
  allowedTools: z.array(z.string()),
  prompt: z.string(),
  /** What "done" means, in words. */
  goal: z.string().min(1),
  /** Exit 0 = the goal is met. Null: the agent ending on its own counts as done. */
  doneCommand: z.string().min(1).nullable(),
  /** Percent of the context window that triggers a handoff. */
  handoffAtPct: z.number().int().min(30).max(80).default(50),
  maxShifts: z.number().int().min(1).max(30).default(8),
  /** Cap for the whole station, across shifts. */
  maxBudgetUsd: z.number().positive().optional(),
  /** Pause before each new shift so a human can review and edit the handoff. */
  reviewHandoff: z.boolean().default(false),
});

export const qaViewportSchema = z.enum(["desktop", "mobile"]);
export type QaViewport = z.infer<typeof qaViewportSchema>;
/** Pixel sizes per viewport (CSS px). */
export const QA_VIEWPORTS: Record<QaViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export const qaThemeSchema = z.enum(["light", "dark"]);
export type QaTheme = z.infer<typeof qaThemeSchema>;

/** A route or flow checked on every QA run, whatever the diff touched. */
export const qaAlwaysCheckSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Path relative to the preview's base URL, e.g. "/settings". */
  path: z.string().trim().startsWith("/"),
  /** Phase 2: plain-language steps the agent clicks through. */
  steps: z.string().max(2_000).optional(),
});
export type QaAlwaysCheck = z.infer<typeof qaAlwaysCheckSchema>;

/**
 * Runs the app twice (base and this branch), screenshots and diffs both, then a
 * Claude session judges the changed screens. A `fail` verdict loops back to the builder.
 */
export const qaStationSchema = z.object({
  key: stationKeySchema,
  kind: z.literal("qa"),
  name: z.string().min(1),
  model: z.string().min(1),
  effort: effortSchema.optional(),
  /** Extra QA instructions for the judge. */
  prompt: z.string(),
  viewports: z.array(qaViewportSchema).min(1).default(["desktop"]),
  themes: z.array(qaThemeSchema).min(1).default(["light"]),
  alwaysCheck: z.array(qaAlwaysCheckSchema).max(20).default([]),
  /**
   * Pixel difference (% of the screen) above which a screen counts as changed.
   * Captures are deterministic (unchanged screens diff at 0%), so the default is
   * low: one added nav link is ~0.04% of a 1440×900 page.
   */
  diffThresholdPct: z.number().min(0).max(100).default(0.01),
  /** The judge may click through the PR preview with a browser. */
  interactive: z.boolean().default(true),
  /**
   * A short planning session picks the screens and scenarios from the work
   * order, the diff and the project's route map before capture. Off: pinned
   * routes + routes derived from file paths + "/".
   */
  planner: z.boolean().default(true),
  maxBudgetUsd: z.number().positive().optional(),
});

export const stationSchema = z.discriminatedUnion("kind", [
  agentStationSchema,
  gateStationSchema,
  checksStationSchema,
  shiftStationSchema,
  qaStationSchema,
]);
export type Station = z.infer<typeof stationSchema>;
export type AgentStation = z.infer<typeof agentStationSchema>;
export type ChecksStation = z.infer<typeof checksStationSchema>;
export type ShiftStation = z.infer<typeof shiftStationSchema>;
export type QaStation = z.infer<typeof qaStationSchema>;

export const updateLineSchema = z.object({
  stations: z
    .array(stationSchema)
    .min(1)
    .refine((stations) => new Set(stations.map((s) => s.key)).size === stations.length, {
      message: "station keys must be unique",
    }),
});
export type UpdateLine = z.infer<typeof updateLineSchema>;

export const lineSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  stations: z.array(stationSchema),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Line = z.infer<typeof lineSchema>;

// ── Project ─────────────────────────────────────────────────────────────────

/** How to run the project's app locally, for QA stations. */
export const previewSchema = z.object({
  /** Runs once per worktree before start, e.g. "pnpm install --frozen-lockfile". */
  install: z.string().trim().min(1).nullable().default(null),
  /**
   * `$PORT` is injected (also as the PORT env var), e.g. "pnpm dev --port $PORT".
   * `$PORT2` (env PORT2) is a second free port, e.g. for a mock API server.
   * Both are also replaced inside `env` values.
   */
  start: z.string().trim().min(1),
  /** Polled until it answers HTTP 2xx/3xx. */
  readyPath: z.string().trim().startsWith("/").default("/"),
  readyTimeoutSec: z.number().int().min(5).max(900).default(120),
  /** Extra env for install and start, e.g. { VITE_MOCKS: "1" }. */
  env: z.record(z.string(), z.string()).default({}),
  /** Prefix for every checked path, e.g. "/app". */
  baseUrlPath: z.string().trim().startsWith("/").default("/"),
  /**
   * JavaScript run in every page before load (captures and the judge's browser):
   * apply a theme (`theme` holds "light" or "dark"), seed a session in
   * localStorage, … `$PORT`/`$PORT2` are replaced like in `start`.
   * Null: themes are emulated via prefers-color-scheme only.
   */
  themeInit: z.string().max(2_000).nullable().default(null),
});
export type Preview = z.infer<typeof previewSchema>;

/**
 * How approved work leaves ZASTAVA: a commit on its branch only, or pushed
 * with a draft / ready pull request.
 */
export const deliveryModeSchema = z.enum(["local", "draft_pr", "pr"]);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  preview: previewSchema.nullable(),
  /** What approving the final gate does unless that approval picks another mode. */
  deliveryDefault: deliveryModeSchema,
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Project = z.infer<typeof projectSchema>;

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    baseBranch: z.string().trim().min(1),
    preview: previewSchema.nullable(),
    deliveryDefault: deliveryModeSchema,
  })
  .partial();
export type UpdateProject = z.infer<typeof updateProjectSchema>;

/** Result of booting the preview once on the base branch. */
export const previewTestResultSchema = z.object({
  ok: z.boolean(),
  /** Install + start output, tail only. */
  logs: z.string(),
  /** Why it failed, in one line; null when ok. */
  error: z.string().nullable(),
  durationMs: z.number().int(),
  /** API path of the screenshot of readyPath (cache-busted), null when none was taken. */
  screenshotUrl: z.string().nullable(),
  testedAt: isoDate,
});
export type PreviewTestResult = z.infer<typeof previewTestResultSchema>;

/** A preview proposed from the repo's files; nothing is saved until the user saves it. */
export const previewDetectionSchema = z.object({
  /** Null when nothing runnable was found (see notes). */
  preview: previewSchema.nullable(),
  /** e.g. "Vite", "Next.js", "Static site"; null when unknown. */
  framework: z.string().nullable(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).nullable(),
  /** Node pinned by .nvmrc / .node-version, e.g. "22.12.0"; the preview runs under it via nvm. */
  nodeVersion: z.string().nullable(),
  /** What was found and what to check by hand, one sentence each. */
  notes: z.array(z.string()),
});
export type PreviewDetection = z.infer<typeof previewDetectionSchema>;

/** Where approved work can go: checked live from the repo and gh. */
export const projectRemoteSchema = z.object({
  /** `origin` URL; null when the repo has none. */
  origin: z.string().nullable(),
  /** origin is on GitHub (gh can open pull requests there). */
  github: z.boolean(),
  /** gh is installed and logged in. */
  ghLoggedIn: z.boolean(),
  /** Draft / ready PR delivery can work. */
  prPossible: z.boolean(),
  /** Why not, in one sentence; null when possible. */
  reason: z.string().nullable(),
});
export type ProjectRemote = z.infer<typeof projectRemoteSchema>;

/** The project's last preview test (persisted on disk by the worker), if any. */
export const previewStatusSchema = z.object({ last: previewTestResultSchema.nullable() });
export type PreviewStatus = z.infer<typeof previewStatusSchema>;

/** One screen of the app, as the route discovery session (or a human) described it. */
export const routeEntrySchema = z.object({
  /** Router pattern, e.g. "/:workspace/projects/:id". */
  path: z.string().trim().startsWith("/").max(300),
  /** A concrete URL that works against the preview's data, e.g. "/1-infinum/projects/482". */
  example: z.string().trim().startsWith("/").max(500),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  /** Files (repo-relative) that render this screen; helps map a diff to it. */
  components: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
});
export type RouteEntry = z.infer<typeof routeEntrySchema>;

/** The project's screens; QA's planner maps a diff onto it. */
export const routeMapSchema = z.object({
  /** Repo-relative files the map was read from (router, mocks); their hash keys the cache. */
  routerFiles: z.array(z.string()),
  routes: z.array(routeEntrySchema),
  /** sha256 of routerFiles at the base branch when the map was made; null = unknown. */
  sourceHash: z.string().nullable(),
  generatedAt: isoDate,
  /** A human edited the map: it is never regenerated automatically. */
  editedByHuman: z.boolean(),
});
export type RouteMap = z.infer<typeof routeMapSchema>;

/** GET /projects/:id/routes */
export const routeMapStatusSchema = z.object({
  map: routeMapSchema.nullable(),
  /** routerFiles changed on the base branch since the map was made. */
  stale: z.boolean(),
  /** A discovery session is running now. */
  discovering: z.boolean(),
  /** The last discovery, if any. */
  lastDiscovery: z
    .object({
      ok: z.boolean(),
      error: z.string().nullable(),
      costUsd: z.number(),
      durationMs: z.number().int(),
      finishedAt: isoDate,
    })
    .nullable(),
});
export type RouteMapStatus = z.infer<typeof routeMapStatusSchema>;
export type RouteDiscovery = NonNullable<RouteMapStatus["lastDiscovery"]>;

/** PUT /projects/:id/routes — a human edit; marks the map editedByHuman. */
export const updateRoutesSchema = z.object({
  routes: z.array(routeEntrySchema).max(300),
  routerFiles: z.array(z.string().trim().min(1)).max(50).optional(),
});
export type UpdateRoutes = z.infer<typeof updateRoutesSchema>;

/** What the route discovery session returns (also its JSON schema). */
export const routeDiscoveryOutputSchema = z.object({
  routerFiles: z.array(z.string()),
  routes: z.array(
    z.object({
      path: z.string(),
      example: z.string(),
      title: z.string(),
      description: z.string(),
      components: z.array(z.string()),
    }),
  ),
});
export type RouteDiscoveryOutput = z.infer<typeof routeDiscoveryOutputSchema>;
const { $schema: _routesDialect, ...routeDiscoveryJsonSchema } = z.toJSONSchema(
  routeDiscoveryOutputSchema,
  { target: "draft-7" },
);
export const ROUTE_DISCOVERY_JSON_SCHEMA: Record<string, unknown> = routeDiscoveryJsonSchema;

/** What the QA planner returns (also its JSON schema). */
export const qaPlanSchema = z.object({
  screens: z.array(z.object({ name: z.string(), path: z.string(), reason: z.string() })),
  scenarios: z.array(
    z.object({ name: z.string(), path: z.string(), steps: z.string(), reason: z.string() }),
  ),
});
export type QaPlan = z.infer<typeof qaPlanSchema>;
const { $schema: _planDialect, ...qaPlanJsonSchema } = z.toJSONSchema(qaPlanSchema, {
  target: "draft-7",
});
export const QA_PLAN_JSON_SCHEMA: Record<string, unknown> = qaPlanJsonSchema;

export const createProjectSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).default("main"),
});
export type CreateProject = z.infer<typeof createProjectSchema>;

export const projectStatsSchema = z.object({
  projectId: z.uuid(),
  costUsd: z.number(),
  runs: z.number().int(),
  done: z.number().int(),
});
export type ProjectStats = z.infer<typeof projectStatsSchema>;

// ── Repos (local runner) ────────────────────────────────────────────────────

export const repoSchema = z.object({
  name: z.string(),
  path: z.string(),
  currentBranch: z.string().nullable(),
});
export type Repo = z.infer<typeof repoSchema>;

export const listBranchesQuerySchema = z.object({ path: z.string().min(1) });

export const systemInfoSchema = z.object({
  /** The folder the repo picker scans: Settings → Repos folder, else the env default. */
  reposRoot: z.string(),
  /** Used when Settings → Repos folder is empty. */
  reposRootDefault: z.string(),
  /** What the worker will use for new sessions, judged from its environment. */
  authSource: authSourceSchema,
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

// ── Doctor (first-run checks) ───────────────────────────────────────────────

export const doctorCheckKeySchema = z.enum([
  "claude",
  "git",
  "database",
  "temporal",
  "worker",
  "repos",
  "gh",
  "chromium",
  "nvm",
]);
export type DoctorCheckKey = z.infer<typeof doctorCheckKeySchema>;

export const doctorCheckSchema = z.object({
  key: doctorCheckKeySchema,
  label: z.string(),
  /** ok · warn (optional piece missing, or works with a caveat) · fail (required piece missing). */
  status: z.enum(["ok", "warn", "fail"]),
  /** Required checks block runs; optional ones only limit features. */
  required: z.boolean(),
  /** What was found, e.g. "git 2.47.1" or "Not logged in". */
  detail: z.string(),
  /** What it is needed for, shown for optional checks, e.g. "Needed for pull requests". */
  neededFor: z.string().nullable(),
  /** How to fix it, in one sentence; null when ok. */
  fix: z.string().nullable(),
  /** A shell command that fixes it, shown with a copy button; null when none. */
  fixCommand: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorReportSchema = z.object({
  /** Every required check passed. */
  ready: z.boolean(),
  checks: z.array(doctorCheckSchema),
  checkedAt: isoDate,
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

const usageWindowSchema = z.object({
  /** 0–100, percent of the window used. */
  utilization: z.number().nullable(),
  resetsAt: isoDate.nullable(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

/** claude.ai plan limits; `available: false` on API keys or when the probe fails. */
export const planUsageSchema = z.object({
  available: z.boolean(),
  subscriptionType: z.string().nullable(),
  fiveHour: usageWindowSchema.nullable(),
  sevenDay: usageWindowSchema.nullable(),
  sevenDayOpus: usageWindowSchema.nullable(),
  sevenDaySonnet: usageWindowSchema.nullable(),
  fetchedAt: isoDate,
  error: z.string().nullable(),
});
export type PlanUsage = z.infer<typeof planUsageSchema>;

// ── Work order ──────────────────────────────────────────────────────────────

export const workOrderStatusSchema = z.enum([
  "backlog",
  /** Waiting for the dispatcher (a free slot, plan headroom, or the night shift). */
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "rejected",
  "cancelled",
]);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

// ── CI ──────────────────────────────────────────────────────────────────────

/** gh's grouping of a check's state (`gh pr checks --json bucket`). */
export const ciBucketSchema = z.enum(["pass", "fail", "pending", "skipping", "cancel"]);
export type CiBucket = z.infer<typeof ciBucketSchema>;

/** One check on the PR: a GitHub Actions job or a commit status (Semaphore…). */
export const ciCheckSchema = z.object({
  name: z.string(),
  /** Actions workflow name; null for commit statuses. */
  workflow: z.string().nullable(),
  bucket: ciBucketSchema,
  link: z.string().nullable(),
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
});
export type CiCheck = z.infer<typeof ciCheckSchema>;

export const ciStateSchema = z.enum(["pending", "passed", "failed", "no_ci", "timed_out"]);
export type CiState = z.infer<typeof ciStateSchema>;

/** The repo's CI on a work order's pull request, as last seen by ZASTAVA. */
export const ciStatusSchema = z.object({
  state: ciStateSchema,
  /** One line, e.g. "3/4 passed · 1 failed". */
  summary: z.string(),
  prState: z.enum(["open", "closed", "merged"]),
  /** The PR head the checks ran on. */
  headSha: z.string().nullable(),
  /** The head when ZASTAVA delivered; differs from headSha once someone pushed. */
  deliveredSha: z.string().nullable(),
  checks: z.array(ciCheckSchema),
  /** When the current watch started (delivery, or a refresh that found work pending). */
  startedAt: isoDate,
  checkedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type CiStatus = z.infer<typeof ciStatusSchema>;

/** asap = next free slot; night = only inside the night-shift window. */
export const queueModeSchema = z.enum(["asap", "night"]);
export type QueueMode = z.infer<typeof queueModeSchema>;

export const workOrderSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  description: z.string(),
  status: workOrderStatusSchema,
  /** Station the order is at; null while in backlog or done. */
  stationKey: z.string().nullable(),
  /** Fractional ordering inside a board column. */
  position: z.number(),
  branch: z.string().nullable(),
  currentRunId: z.uuid().nullable(),
  /** Overrides every agent station's model for this order. */
  modelOverride: z.string().nullable(),
  effortOverride: effortSchema.nullable(),
  /** Run-level cap: the line stops before a station once spend reaches it. */
  maxBudgetUsd: z.number().nullable(),
  prUrl: z.string().nullable(),
  /** CI on the pull request; null until ZASTAVA has looked. */
  ci: ciStatusSchema.nullable(),
  queueMode: queueModeSchema.nullable(),
  queuedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

export const createWorkOrderSchema = z.object({
  /** Client-generated id makes offline creation idempotent. */
  id: z.uuid().optional(),
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  position: z.number().optional(),
  modelOverride: z.string().nullable().optional(),
  effortOverride: effortSchema.nullable().optional(),
  maxBudgetUsd: z.number().positive().nullable().optional(),
});
export type CreateWorkOrder = z.infer<typeof createWorkOrderSchema>;

export const updateWorkOrderSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    position: z.number(),
    modelOverride: z.string().nullable(),
    effortOverride: effortSchema.nullable(),
    maxBudgetUsd: z.number().positive().nullable(),
  })
  .partial();
export type UpdateWorkOrder = z.infer<typeof updateWorkOrderSchema>;

export const listWorkOrdersQuerySchema = z.object({ projectId: z.uuid() });

/** Push the branch of work delivered locally and open a pull request for it. */
export const openPullRequestSchema = z.object({ draft: z.boolean().default(false) });
export type OpenPullRequest = z.infer<typeof openPullRequestSchema>;

export const openPullRequestResultSchema = z.object({ prUrl: z.string() });
export type OpenPullRequestResult = z.infer<typeof openPullRequestResultSchema>;

/** A work order waiting at a gate, across projects (desktop tray, badge). */
export const needsYouItemSchema = z.object({
  workOrderId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string(),
  title: z.string(),
  /** When it started waiting (last update). */
  since: isoDate,
});
export type NeedsYouItem = z.infer<typeof needsYouItemSchema>;

export const shiftStatusSchema = z.enum([
  "running",
  "handing_off",
  /** Finished; the next shift waits for a human to review this handoff. */
  "awaiting_review",
  "done",
  "failed",
  "cancelled",
]);
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

// ── Runs ────────────────────────────────────────────────────────────────────

export const runStatusSchema = z.enum([
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stationRunStatusSchema = z.enum([
  "running",
  "awaiting_approval",
  /** A gate sent the work back to the builder with a comment. */
  "changes_requested",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
]);
export type StationRunStatus = z.infer<typeof stationRunStatusSchema>;

export const findingSchema = z.object({
  severity: z.enum(["critical", "important", "minor"]),
  file: z.string().nullable(),
  message: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const verdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string(),
  findings: z.array(findingSchema),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** JSON schema handed to the Agent SDK's outputFormat for validator stations. */
// Claude Code's validator only knows draft-07, and rejects any `$schema` URI.
const { $schema: _dialect, ...verdictJsonSchema } = z.toJSONSchema(verdictSchema, {
  target: "draft-7",
});
export const VERDICT_JSON_SCHEMA: Record<string, unknown> = verdictJsonSchema;

export const stationRunSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  stationKey: z.string(),
  attempt: z.number().int(),
  status: stationRunStatusSchema,
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  authSource: authSourceSchema.nullable(),
  output: z.string().nullable(),
  verdict: verdictSchema.nullable(),
  error: z.string().nullable(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  /** Tokens in the context window at the session's last turn. */
  contextTokens: z.number().int(),
  contextWindow: z.number().int().nullable(),
  numTurns: z.number().int(),
  /** Shift stations only: the latest shift's number and task progress. */
  shift: z
    .object({
      number: z.number().int(),
      status: shiftStatusSchema,
      tasksDone: z.number().int(),
      tasksTotal: z.number().int(),
    })
    .nullable(),
  /** QA stations only: the latest QA attempt's counts (for `QA · 7/9 · 2 diffs`). */
  qa: z
    .object({
      qaRunId: z.uuid(),
      status: z.enum(["running", "passed", "failed", "error"]),
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      /** Screens whose pixels changed (failed, changed or intended visual checks). */
      diffs: z.number().int(),
    })
    .nullable(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type StationRun = z.infer<typeof stationRunSchema>;

export const runSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  status: runStatusSchema,
  workflowId: z.string(),
  worktreePath: z.string().nullable(),
  costUsd: z.number(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
  stations: z.array(stationRunSchema),
});
export type Run = z.infer<typeof runSchema>;

export const runDiffSchema = z.object({
  stat: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
});
export type RunDiff = z.infer<typeof runDiffSchema>;

export const listRunsQuerySchema = z.object({ workOrderId: z.uuid() });

export const gateDecisionSchema = z
  .object({
    /** request_changes sends the work back to the builder, resuming its Claude session. */
    decision: z.enum(["approve", "reject", "request_changes"]),
    comment: z.string().max(5_000).default(""),
    /**
     * Approve at the last gate only: overrides the project's delivery settings
     * (local only, draft PRs) for this run. Omitted = the project's settings.
     */
    delivery: deliveryModeSchema.optional(),
  })
  .refine((d) => d.decision !== "request_changes" || d.comment.trim().length > 0, {
    message: "a comment is required when requesting changes",
    path: ["comment"],
  });
export type GateDecision = z.infer<typeof gateDecisionSchema>;

export const runEventTypeSchema = z.enum([
  "text",
  "tool_use",
  "tool_result",
  "result",
  "system",
  "error",
  /** A screenshot; `message` is JSON matching `imageEventSchema`. */
  "image",
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

/** Payload of an `image` run event. */
export const imageEventSchema = z.object({
  /** Path inside the run's artifact dir; fetch it from `GET /runs/:id/qa/files/<file>`. */
  file: z.string(),
  caption: z.string(),
  /** base / pr / diff: deterministic capture; agent: the QA judge's own browser screenshot. */
  role: z.enum(["base", "pr", "diff", "agent", "preview"]),
  checkId: z.uuid().nullable(),
});
export type ImageEvent = z.infer<typeof imageEventSchema>;

export const runEventSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  stationRunId: z.uuid().nullable(),
  seq: z.number().int(),
  type: runEventTypeSchema,
  message: z.string(),
  createdAt: isoDate,
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const listRunEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

// ── Shifts ──────────────────────────────────────────────────────────────────

/** Forward-looking note one shift leaves for the next (also the handoff turn's JSON schema). */
export const handoffSchema = z.object({
  /** 2–4 sentences: where things stand. */
  summary: z.string(),
  done: z.array(z.string()),
  /** Exact state of unfinished work: files, what is half-done. */
  inProgress: z.string().nullable(),
  /** Ordered, concrete. */
  nextSteps: z.array(z.string()),
  /** Learnings, traps, decisions not to revisit. */
  gotchas: z.array(z.string()),
  /** Worktree-relative paths the next shift should open first. */
  filesToRead: z.array(z.string()),
});
export type Handoff = z.infer<typeof handoffSchema>;

const { $schema: _handoffDialect, ...handoffJsonSchema } = z.toJSONSchema(handoffSchema, {
  target: "draft-7",
});
export const HANDOFF_JSON_SCHEMA: Record<string, unknown> = handoffJsonSchema;

export const shiftEndReasonSchema = z.enum([
  "threshold",
  "done",
  "stuck",
  "budget",
  "max_shifts",
  "error",
  "cancelled",
  /** A human asked for the handoff (Handoff now) or to stop after this shift. */
  "manual",
]);
export type ShiftEndReason = z.infer<typeof shiftEndReasonSchema>;

export const shiftSchema = z.object({
  id: z.uuid(),
  stationRunId: z.uuid(),
  stationKey: z.string(),
  /** 1-based, counted across the run (a loop-back continues the numbering). */
  number: z.number().int(),
  status: shiftStatusSchema,
  sessionId: z.string().nullable(),
  contextTokens: z.number().int(),
  contextWindow: z.number().int().nullable(),
  /** The station's handoff threshold, copied so the UI can draw the line. */
  handoffAtPct: z.number().int(),
  costUsd: z.number(),
  numTurns: z.number().int(),
  commits: z.number().int(),
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
  handoff: handoffSchema.nullable(),
  endReason: shiftEndReasonSchema.nullable(),
  /** Set by "Handoff now"; the worker hands off at the next turn boundary. */
  handoffRequested: z.boolean(),
  /** Set by "Stop after this shift". */
  stopAfter: z.boolean(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type Shift = z.infer<typeof shiftSchema>;

export const shiftTaskSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]).catch("todo"),
  notes: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
export type ShiftTask = z.infer<typeof shiftTaskSchema>;

/** Agents write tasks.json by hand: accept a bare array or `{ tasks: [] }`, skip junk entries. */
export function parseShiftTasks(raw: string | null): ShiftTask[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(json)
    ? json
    : (z.object({ tasks: z.array(z.unknown()) }).safeParse(json).data?.tasks ?? []);
  return list.flatMap((item) => {
    const parsed = shiftTaskSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The run's durable memory, read from `.zastava/` in the worktree. */
export const runMemorySchema = z.object({
  goal: z.string().nullable(),
  tasks: z.array(shiftTaskSchema),
  progress: z.string().nullable(),
  learnings: z.string().nullable(),
});
export type RunMemory = z.infer<typeof runMemorySchema>;

export const shiftReviewSchema = z.object({
  decision: z.enum(["continue", "stop"]),
  /** Edited handoff; replaces the stored one and goes into the next shift's prompt. */
  handoff: handoffSchema.optional(),
});
export type ShiftReview = z.infer<typeof shiftReviewSchema>;

/** Payload of SHIFT_CONTROL_SIGNAL. */
export type ShiftControl =
  | { action: "stop_after" }
  | { action: "review"; decision: "continue" | "stop"; handoff?: Handoff };

// ── QA ──────────────────────────────────────────────────────────────────────

export const qaRunStatusSchema = z.enum(["running", "passed", "failed", "error"]);
export type QaRunStatus = z.infer<typeof qaRunStatusSchema>;

export const qaCheckKindSchema = z.enum(["visual", "scenario", "console", "a11y"]);
export type QaCheckKind = z.infer<typeof qaCheckKindSchema>;

/**
 * pass = unchanged or fine · changed = pixels moved, not judged yet ·
 * intended = changed on purpose (agent or human) · fail = a defect · error = could not check.
 */
export const qaCheckStatusSchema = z.enum(["pass", "fail", "changed", "intended", "error"]);
export type QaCheckStatus = z.infer<typeof qaCheckStatusSchema>;

export const qaStepSchema = z.object({
  action: z.string(),
  target: z.string().nullable(),
  /** Artifact file of the step's screenshot. */
  shot: z.string().nullable(),
  ok: z.boolean(),
  note: z.string().nullable(),
});
export type QaStep = z.infer<typeof qaStepSchema>;

export const qaCheckSchema = z.object({
  id: z.uuid(),
  qaRunId: z.uuid(),
  name: z.string(),
  kind: qaCheckKindSchema,
  viewport: qaViewportSchema.nullable(),
  theme: qaThemeSchema.nullable(),
  path: z.string().nullable(),
  status: qaCheckStatusSchema,
  diffPct: z.number().nullable(),
  /** Artifact files (see imageEventSchema.file); null when not captured. */
  baseShot: z.string().nullable(),
  prShot: z.string().nullable(),
  diffShot: z.string().nullable(),
  steps: z.array(qaStepSchema),
  note: z.string().nullable(),
  /** Why QA looked at this: the planner's reason, "Pinned route", the changed file, … */
  reason: z.string().nullable(),
  severity: findingSchema.shape.severity.nullable(),
  /** Set when a human clicked "Accept as intended". */
  acceptedAt: isoDate.nullable(),
  position: z.number().int(),
});
export type QaCheck = z.infer<typeof qaCheckSchema>;

export const qaRunSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  stationRunId: z.uuid(),
  stationKey: z.string(),
  /** 1-based QA attempt within the run (loop-backs add attempts). */
  attempt: z.number().int(),
  status: qaRunStatusSchema,
  baseSha: z.string().nullable(),
  prSha: z.string().nullable(),
  baseUrl: z.string().nullable(),
  prUrl: z.string().nullable(),
  summary: z.string().nullable(),
  checks: z.array(qaCheckSchema),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type QaRun = z.infer<typeof qaRunSchema>;

/** What the QA judge returns (also its JSON schema). `ref` points at a check from the prompt. */
export const qaVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string(),
  checks: z.array(
    z.object({
      /** e.g. "c3" for a listed check; null for a new problem the judge found itself. */
      ref: z.string().nullable(),
      name: z.string(),
      status: z.enum(["pass", "fail", "intended"]),
      severity: z.enum(["critical", "important", "minor"]).nullable(),
      note: z.string(),
      path: z.string().nullable(),
    }),
  ),
});
export type QaVerdict = z.infer<typeof qaVerdictSchema>;

const { $schema: _qaDialect, ...qaVerdictJsonSchema } = z.toJSONSchema(qaVerdictSchema, {
  target: "draft-7",
});
export const QA_VERDICT_JSON_SCHEMA: Record<string, unknown> = qaVerdictJsonSchema;

// ── Queue & dispatcher ──────────────────────────────────────────────────────

export const enqueueSchema = z.object({ mode: queueModeSchema.default("asap") });
export type Enqueue = z.infer<typeof enqueueSchema>;

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const settingsSchema = z.object({
  /** Agent runs allowed at once; runs parked at a gate do not count. */
  maxConcurrentRuns: z.number().int().min(1).max(10),
  /** Dispatcher pauses new work at this 5-hour plan utilization (percent). */
  pauseAtFiveHourPct: z.number().int().min(10).max(100),
  pauseAtWeeklyPct: z.number().int().min(10).max(100),
  nightShiftStart: clockTime,
  nightShiftEnd: clockTime,
  /** Base URL for deep links in notifications. */
  appUrl: z.url(),
  desktopNotifications: z.boolean(),
  slackWebhookUrl: z.url().nullable(),
  telegramBotToken: z.string().nullable(),
  telegramChatId: z.string().nullable(),
  /** Folder the repo picker scans (absolute or ~/…); null = the default from SystemInfo. */
  reposRoot: z.string().trim().min(1).nullable(),
  /** Masked API key ("sk-ant-…x7Qd"); the key itself is never returned. Null = Claude plan login. */
  anthropicApiKeyHint: z.string().nullable(),
  /** "env" = ANTHROPIC_API_KEY of the environment (not removable here); "settings" = saved in Settings. */
  anthropicApiKeySource: z.enum(["settings", "env"]).nullable(),
  updatedAt: isoDate,
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsSchema = settingsSchema
  .omit({ updatedAt: true, anthropicApiKeyHint: true, anthropicApiKeySource: true })
  .partial()
  .extend({
    /** Write-only: a key saves it (checked with Anthropic first), null removes the saved key. */
    anthropicApiKey: z.string().trim().min(1).nullable().optional(),
  });
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

export const dispatcherStateSchema = z.object({
  status: z.enum(["active", "paused_usage", "waiting_night_shift", "idle"]),
  /** Human-readable reason shown in the UI. */
  reason: z.string(),
  running: z.number().int(),
  queued: z.number().int(),
  queuedNight: z.number().int(),
  slots: z.number().int(),
  inNightShift: z.boolean(),
  resumesAt: isoDate.nullable(),
  checkedAt: isoDate,
});
export type DispatcherState = z.infer<typeof dispatcherStateSchema>;

export const notificationTestSchema = z.object({
  channel: z.enum(["desktop", "slack", "telegram"]),
});

// ── Realtime ────────────────────────────────────────────────────────────────

export const collectionNameSchema = z.enum([
  "projects",
  "work_orders",
  "runs",
  "settings",
  "dispatcher",
  "shifts",
  "qa",
]);
export type CollectionName = z.infer<typeof collectionNameSchema>;

/** What travels over NOTIFY and SSE. Kept tiny: NOTIFY payloads cap at 8kB. */
export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invalidate"), collection: collectionNameSchema }),
  z.object({ type: z.literal("run_event"), runId: z.uuid(), seq: z.number().int() }),
  /**
   * A desktop notification for the desktop app to show natively (sent instead
   * of the osascript one when the backend runs inside the app).
   */
  z.object({
    type: z.literal("notice"),
    title: z.string().max(200),
    body: z.string().max(2_000),
    url: z.string().max(1_000),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

// ── Default line ────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
const BUILD_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];

/** The line every new project starts with: researcher → gate → builder → validator → gate. */
export const DEFAULT_STATIONS: Station[] = [
  {
    key: "research",
    kind: "agent",
    name: "Research",
    role: "codebase-researcher",
    model: "claude-haiku-4-5-20251001",
    effort: "medium",
    allowedTools: READ_ONLY_TOOLS,
    canEdit: false,
    prompt:
      "You are the codebase researcher. Map every part of the repository relevant to the work order: files, patterns, conventions, risks. Do not modify anything. End with a concise plan for the builder as a numbered list.",
  },
  {
    key: "plan_gate",
    kind: "gate",
    name: "Approve plan",
    prompt: "Review the research and plan before any code is written.",
  },
  {
    key: "build",
    kind: "agent",
    name: "Build",
    role: "builder",
    model: "claude-sonnet-5-5",
    effort: "high",
    allowedTools: BUILD_TOOLS,
    canEdit: true,
    prompt:
      "You are the builder. Implement the work order following the approved plan and the repository's existing patterns. Add or update tests. Run the project's typecheck/lint/tests if they exist. Commit nothing; leave changes in the working tree. End with a summary of changed files.",
  },
  {
    key: "validate",
    kind: "agent",
    name: "Validate",
    role: "implementation-validator",
    model: "claude-sonnet-5-5",
    effort: "high",
    allowedTools: [...READ_ONLY_TOOLS, "Bash"],
    canEdit: false,
    structuredVerdict: true,
    prompt:
      "You are the implementation validator. Compare the working-tree changes (git diff) against the work order and the plan. Never fix anything. Classify each finding as critical (must fix: bugs, security, missing acceptance criteria), important or minor. List only real problems in findings; an empty findings array is the correct answer when there are none (never add an entry saying there are no issues). verdict is 'fail' only when there is at least one critical finding.",
  },
  {
    key: "review_gate",
    kind: "gate",
    name: "Final review",
    prompt: "Review the diff and the validator report before merging.",
  },
];

/**
 * Station key of the delivery preflight (the repo's pre-commit hook), which
 * the worker runs before the final gate when the repo has such a hook. It is
 * not a line station: clients draw it as a step just before the final gate
 * when a run has station runs with this key.
 */
export const REPO_HOOKS_STATION_KEY = "repo_hooks";

/**
 * Station key of the CI watch after delivery (the PR's checks: GitHub
 * Actions, Semaphore…). Like repo hooks it is not a line station: clients draw
 * it after the last station when a run has station runs with this key.
 */
export const CI_STATION_KEY = "ci";

/**
 * Where "Request changes" at a gate sends the work: the closest earlier
 * station that edits code (agent with canEdit, or shift); when none comes
 * before the gate (a plan gate after research), the closest earlier agent,
 * which revises its output. -1: nothing to send back to (the gate rejects).
 */
export function requestChangesTarget(stations: Station[], gateIndex: number): number {
  const before = stations.slice(0, Math.max(0, gateIndex));
  const editor = before.findLastIndex(
    (s) => (s.kind === "agent" && s.canEdit) || s.kind === "shift",
  );
  if (editor >= 0) return editor;
  return before.findLastIndex((s) => s.kind === "agent");
}

/**
 * The line with a QA station (from the template) right after the last station
 * that edits code, so QA judges the finished change before the final gate.
 * Unchanged when the line already has QA or nothing edits code.
 */
export function withQaStation(stations: Station[]): Station[] {
  if (stations.some((s) => s.kind === "qa")) return stations;
  const lastEditor = stations.findLastIndex((s) => s.kind === "agent" && s.canEdit);
  if (lastEditor === -1) return stations;
  const taken = new Set(stations.map((s) => s.key));
  let key = QA_STATION_TEMPLATE.key;
  for (let n = 2; taken.has(key); n++) key = `${QA_STATION_TEMPLATE.key}_${n}`;
  return stations.toSpliced(lastEditor + 1, 0, { ...QA_STATION_TEMPLATE, key });
}

/** Starting point when a QA station is added to a line. */
export const QA_STATION_TEMPLATE: Extract<Station, { kind: "qa" }> = {
  key: "qa",
  kind: "qa",
  name: "QA",
  model: "claude-sonnet-5-5",
  effort: "medium",
  prompt:
    "You are the QA engineer. Judge the running app, not the code: a change the work order asked for is intended; anything else that moved, broke or errors is a defect.",
  viewports: ["desktop"],
  themes: ["light"],
  alwaysCheck: [],
  diffThresholdPct: 0.01,
  interactive: true,
  planner: true,
};
