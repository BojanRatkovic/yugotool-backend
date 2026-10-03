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
  /**
   * Validator stations return a structured verdict (JSON schema output):
   * true = pass/fail `verdictSchema`, "review" = PR review findings (spec 0009).
   */
  structuredVerdict: z.union([z.boolean(), z.literal("review")]).optional(),
  /**
   * Reads the project's knowledge sources (spec 0007). Planning stations only:
   * a station that edits code never gets it (see updateLineSchema).
   */
  useKnowledge: z.boolean().optional(),
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

/** A project has one line per kind. */
export const lineKindSchema = z.enum(["build", "review"]);
export type LineKind = z.infer<typeof lineKindSchema>;

export const updateLineSchema = z.object({
  stations: z
    .array(stationSchema)
    .min(1)
    .refine((stations) => new Set(stations.map((s) => s.key)).size === stations.length, {
      message: "station keys must be unique",
    })
    .refine(
      (stations) => stations.every((s) => s.kind !== "agent" || !s.useKnowledge || !s.canEdit),
      {
        message: "only read-only agent stations can read knowledge",
      },
    ),
});
export type UpdateLine = z.infer<typeof updateLineSchema>;

export const lineSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: lineKindSchema,
  name: z.string(),
  stations: z.array(stationSchema),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Line = z.infer<typeof lineSchema>;

// ── Knowledge sources ───────────────────────────────────────────────────────

/**
 * How a source becomes a read-only folder before a run (spec 0007 §3):
 * git_local / git_remote = snapshot of tracked files at the branch head;
 * path = a copy of a file or folder, minus `excludes`.
 */
export const knowledgeSourceKindSchema = z.enum(["git_local", "git_remote", "path"]);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

/** Excluded by default from `path` sources: secrets that live next to docs. */
export const DEFAULT_KNOWLEDGE_EXCLUDES = [".env*", "private", "secrets"];

export const knowledgeSourceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: knowledgeSourceKindSchema,
  /** Local path (git_local, path) or git URL (git_remote). */
  location: z.string(),
  /** Git kinds: the branch to read; null = the repo's current/default branch. */
  branch: z.string().nullable(),
  /** Where an agent starts reading, relative to the source; null = auto. */
  entryFile: z.string().nullable(),
  /** `path` kind: file/folder names left out of the copy (`*` wildcards). */
  excludes: z.array(z.string()),
  lastSyncedSha: z.string().nullable(),
  lastSyncedAt: isoDate.nullable(),
  /** The entry file the last sync resolved. */
  lastEntryFile: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

const knowledgeSourceFields = {
  name: z.string().trim().min(1).max(80),
  kind: knowledgeSourceKindSchema,
  location: z.string().trim().min(1),
  branch: z.string().trim().min(1).nullable(),
  entryFile: z.string().trim().min(1).nullable(),
  excludes: z.array(z.string().trim().min(1)).max(50),
};

export const createKnowledgeSourceSchema = z.object({
  /** Client-generated id makes creation idempotent. */
  id: z.uuid().optional(),
  ...knowledgeSourceFields,
  branch: knowledgeSourceFields.branch.default(null),
  entryFile: knowledgeSourceFields.entryFile.default(null),
  excludes: knowledgeSourceFields.excludes.default(DEFAULT_KNOWLEDGE_EXCLUDES),
});
export type CreateKnowledgeSource = z.infer<typeof createKnowledgeSourceSchema>;

export const updateKnowledgeSourceSchema = z.object(knowledgeSourceFields).partial();
export type UpdateKnowledgeSource = z.infer<typeof updateKnowledgeSourceSchema>;

/** The project's sources, in the order agents see them. */
export const projectKnowledgeSchema = z.object({
  sourceIds: z.array(z.uuid()).max(20),
});
export type ProjectKnowledge = z.infer<typeof projectKnowledgeSchema>;

/** A synced source as a run hands it to a planning station. */
export interface KnowledgeMount {
  name: string;
  /** Read-only snapshot folder. */
  dir: string;
  /** Git kinds: the commit read; null for path sources. */
  sha: string | null;
  /** Relative to `dir`; null when the source has no obvious start. */
  entryFile: string | null;
}

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
  /**
   * Host the browser opens the preview on (`http://<host>:$PORT`), for apps
   * whose cookies, CORS or redirects expect a name, e.g. "app.example.localhost".
   * It must resolve to this Mac (any *.localhost does). Null: localhost.
   */
  host: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
      "a host name, without scheme or port",
    )
    .max(253)
    .nullable()
    .default(null),
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
/**
 * A signed-in browser session saved for the preview ("Sign in once"): cookies
 * and localStorage every browser on the preview starts with.
 */
export const previewSessionSchema = z.object({
  savedAt: isoDate,
  cookieCount: z.number().int(),
  /** Cookie domains and localStorage origins, for "signed in to …". */
  domains: z.array(z.string()),
});
export type PreviewSession = z.infer<typeof previewSessionSchema>;

/** The interactive sign-in: the worker boots the preview and opens a visible browser. */
/** The parts of a Playwright storage state file ZASTAVA reads (the file holds more). */
export const storageStateSchema = z.object({
  cookies: z.array(z.object({ domain: z.string() }).loose()).default([]),
  origins: z
    .array(z.object({ origin: z.string(), localStorage: z.array(z.unknown()).default([]) }).loose())
    .default([]),
});
export type StorageStateSummary = Pick<PreviewSession, "cookieCount" | "domains">;

/** Cookie count and where the session applies: cookie domains + localStorage hosts. */
export function summarizeStorageState(
  state: z.infer<typeof storageStateSchema>,
): StorageStateSummary {
  const hosts = [
    ...state.cookies.map((c) => c.domain.replace(/^\./, "")),
    ...state.origins
      .filter((o) => o.localStorage.length > 0)
      .map((o) => o.origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "")),
  ];
  return { cookieCount: state.cookies.length, domains: [...new Set(hosts)].toSorted() };
}

export const previewSignInSchema = z.object({
  status: z.enum(["starting", "waiting", "saved", "cancelled", "failed"]),
  /** The URL the browser window opened, once the preview is up. */
  url: z.string().nullable(),
  error: z.string().nullable(),
  /** Install + start output tail, for a preview that did not come up. */
  logs: z.string(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type PreviewSignIn = z.infer<typeof previewSignInSchema>;

export const previewSessionStatusSchema = z.object({
  session: previewSessionSchema.nullable(),
  signIn: previewSignInSchema.nullable(),
});
export type PreviewSessionStatus = z.infer<typeof previewSessionStatusSchema>;

export const finishSignInSchema = z.object({
  /** save: keep what the browser holds now; cancel: discard it. */
  action: z.enum(["save", "cancel"]),
});
export type FinishSignIn = z.infer<typeof finishSignInSchema>;

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

/** `build` runs down the project's line; `review` reviews a pull request. */
export const workOrderKindSchema = z.enum(["build", "review"]);
export type WorkOrderKind = z.infer<typeof workOrderKindSchema>;

/** The PR a review work order looks at, frozen when the review starts. */
export const reviewPullRequestSchema = z.object({
  number: z.number().int().min(1),
  url: z.string(),
  headRefName: z.string(),
  headOid: z.string(),
  baseRefName: z.string(),
  baseOid: z.string(),
  /** Head of the previous ZASTAVA review: a re-review focuses on what came after. */
  sinceOid: z.string().nullable(),
  /** Finding ids already added to the pending review on GitHub. */
  posted: z.array(z.string()).default([]),
});
export type ReviewPullRequest = z.infer<typeof reviewPullRequestSchema>;

export const workOrderSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: workOrderKindSchema,
  title: z.string(),
  description: z.string(),
  /** Review work orders: the PR under review (spec 0009). */
  pullRequest: reviewPullRequestSchema.nullable(),
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

// ── Pull requests ───────────────────────────────────────────────────────────

/** Which board: PRs I opened, or PRs others want my review on (spec 0008). */
export const prScopeSchema = z.enum(["mine", "assigned"]);
export type PrScope = z.infer<typeof prScopeSchema>;

export const prActorSchema = z.object({
  login: z.string(),
  avatarUrl: z.string(),
});
export type PrActor = z.infer<typeof prActorSchema>;

/** The status-check rollup on the head commit; none = the repo has no CI. */
export const prCiStateSchema = z.enum(["success", "failure", "pending", "none"]);
export type PrCiState = z.infer<typeof prCiStateSchema>;

export const prReviewStateSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);
export type PrReviewState = z.infer<typeof prReviewStateSchema>;

export const prReviewerSchema = z.union([
  z.object({ actor: prActorSchema, state: z.union([prReviewStateSchema, z.literal("REQUESTED")]) }),
  z.object({ team: z.string(), state: z.literal("REQUESTED") }),
]);
export type PrReviewer = z.infer<typeof prReviewerSchema>;

/** One PR as a board card: enough to place it in a column and say why. */
export const pullRequestSummarySchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  isDraft: z.boolean(),
  author: prActorSchema,
  headRefName: z.string(),
  baseRefName: z.string(),
  headOid: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
  mergedAt: isoDate.nullable(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  /** UNKNOWN until GitHub computes it; never block on it. */
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  ci: prCiStateSchema,
  /** Names of failing checks, at most 5. */
  failingChecks: z.array(z.string()).max(5),
  reviewers: z.array(prReviewerSchema),
  /** My latest review that isn't PENDING. */
  myLastReview: z
    .object({ state: prReviewStateSchema, commitOid: z.string(), submittedAt: isoDate })
    .nullable(),
  requestedFromMe: z.boolean(),
  requestedFromMyTeam: z.boolean(),
  assignedToMe: z.boolean(),
  threads: z.object({
    unresolved: z.number().int(),
    /** Unresolved threads whose last comment isn't mine. */
    waitingOnMe: z.number().int(),
  }),
  comments: z.number().int(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const pullRequestListSchema = z.object({
  /** "owner/name". */
  repo: z.string(),
  /** The gh user's login: "me" in the board rules. */
  viewer: z.string(),
  items: z.array(pullRequestSummarySchema),
  fetchedAt: isoDate,
});
export type PullRequestList = z.infer<typeof pullRequestListSchema>;

export const pullRequestListQuerySchema = z.object({
  scope: prScopeSchema,
  /** Include team review requests (Assigned only). */
  teams: z.stringbool().default(false),
});
export type PullRequestListQuery = z.infer<typeof pullRequestListQuerySchema>;

export const prThreadCommentSchema = z.object({
  id: z.string(),
  author: prActorSchema,
  /** GitHub's sanitized bodyHTML. */
  bodyHtml: z.string(),
  createdAt: isoDate,
  /** Part of my pending review, not yet visible to others. */
  isPending: z.boolean(),
});
export type PrThreadComment = z.infer<typeof prThreadCommentSchema>;

export const prThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  /** Null when the thread is outdated and its line is gone. */
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  diffHunk: z.string(),
  viewerCanResolve: z.boolean(),
  viewerCanReply: z.boolean(),
  comments: z.array(prThreadCommentSchema),
});
export type PrThread = z.infer<typeof prThreadSchema>;

export const prTimelineItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    id: z.string(),
    author: prActorSchema,
    bodyHtml: z.string(),
    createdAt: isoDate,
  }),
  z.object({
    kind: z.literal("review"),
    id: z.string(),
    author: prActorSchema,
    state: prReviewStateSchema,
    bodyHtml: z.string(),
    createdAt: isoDate,
    threadIds: z.array(z.string()),
  }),
  /** Consecutive pushes grouped into one item. */
  z.object({
    kind: z.literal("commits"),
    count: z.number().int(),
    oids: z.array(z.string()),
    createdAt: isoDate,
    author: prActorSchema.nullable(),
  }),
  z.object({ kind: z.literal("force_push"), createdAt: isoDate, author: prActorSchema.nullable() }),
  z.object({
    kind: z.literal("ready_for_review"),
    createdAt: isoDate,
    author: prActorSchema.nullable(),
  }),
  z.object({
    kind: z.literal("review_requested"),
    createdAt: isoDate,
    author: prActorSchema.nullable(),
    /** A login or a team name. */
    reviewer: z.string(),
  }),
  z.object({ kind: z.literal("merged"), createdAt: isoDate, by: prActorSchema.nullable() }),
  z.object({ kind: z.literal("closed"), createdAt: isoDate, author: prActorSchema.nullable() }),
  z.object({ kind: z.literal("reopened"), createdAt: isoDate, author: prActorSchema.nullable() }),
  z.object({
    kind: z.literal("renamed"),
    createdAt: isoDate,
    author: prActorSchema.nullable(),
    from: z.string(),
    to: z.string(),
  }),
]);
export type PrTimelineItem = z.infer<typeof prTimelineItemSchema>;

export const prMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type PrMergeMethod = z.infer<typeof prMergeMethodSchema>;

export const prCheckSchema = z.object({
  name: z.string(),
  state: ciBucketSchema,
  url: z.string().nullable(),
  /** Actions workflow name; null for commit statuses. */
  workflow: z.string().nullable(),
});
export type PrCheck = z.infer<typeof prCheckSchema>;

export const prFileSchema = z.object({
  path: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changeType: z.enum(["ADDED", "DELETED", "MODIFIED", "RENAMED", "COPIED", "CHANGED"]),
  /** Viewed state, synced with GitHub. */
  viewed: z.boolean(),
});
export type PrFile = z.infer<typeof prFileSchema>;

export const prCommitSchema = z.object({
  oid: z.string(),
  messageHeadline: z.string(),
  author: prActorSchema.nullable(),
  committedAt: isoDate,
  ci: prCiStateSchema,
});
export type PrCommit = z.infer<typeof prCommitSchema>;

/** Everything the PR panel needs. Lists above their caps set `truncated`. */
export const pullRequestDetailSchema = pullRequestSummarySchema.extend({
  bodyHtml: z.string(),
  viewerCanUpdate: z.boolean(),
  viewerCanMerge: z.boolean(),
  /** Merge methods the repo allows. */
  mergeMethods: z.array(prMergeMethodSchema),
  /** My PENDING review, if any. */
  pendingReview: z.object({ id: z.string(), comments: z.number().int() }).nullable(),
  checks: z.array(prCheckSchema),
  /** Up to 300. */
  files: z.array(prFileSchema),
  /** Up to 100 (the summary's `threads` holds the counts). */
  reviewThreads: z.array(prThreadSchema),
  /** Up to 250 items. */
  timeline: z.array(prTimelineItemSchema),
  commits: z.array(prCommitSchema),
  truncated: z.object({
    files: z.boolean(),
    threads: z.boolean(),
    timeline: z.boolean(),
    commits: z.boolean(),
  }),
});
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

export const prDiffQuerySchema = z.object({
  /** Diff from this commit to the head (changes since my last review). */
  since: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
});
export type PrDiffQuery = z.infer<typeof prDiffQuerySchema>;

export const prDiffSchema = z.object({
  /** Unified diff text; cut at 5 MB. */
  patch: z.string(),
  truncated: z.boolean(),
  base: z.string(),
  head: z.string(),
});
export type PrDiff = z.infer<typeof prDiffSchema>;

// Writes

const prBody = z.string().trim().min(1).max(65_536);

/** A comment in the PR conversation. */
export const prCommentInputSchema = z.object({ body: prBody });
export type PrCommentInput = z.infer<typeof prCommentInputSchema>;

/** A reply in a review thread. */
export const prReplyInputSchema = z.object({ body: prBody });
export type PrReplyInput = z.infer<typeof prReplyInputSchema>;

/** A line comment; it goes into my pending review. */
export const prLineCommentInputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  side: z.enum(["LEFT", "RIGHT"]),
  startLine: z.number().int().min(1).optional(),
  startSide: z.enum(["LEFT", "RIGHT"]).optional(),
  body: prBody,
});
export type PrLineCommentInput = z.infer<typeof prLineCommentInputSchema>;

export const prSubmitReviewInputSchema = z.object({
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  /** May be empty for APPROVE, or when the pending review has comments. */
  body: z.string().trim().max(65_536),
});
export type PrSubmitReviewInput = z.infer<typeof prSubmitReviewInputSchema>;

export const prViewedInputSchema = z.object({ path: z.string().min(1), viewed: z.boolean() });
export type PrViewedInput = z.infer<typeof prViewedInputSchema>;

export const prMergeInputSchema = z.object({ method: prMergeMethodSchema });
export type PrMergeInput = z.infer<typeof prMergeInputSchema>;

// ── PR review (spec 0009) ───────────────────────────────────────────────────

export const reviewFindingSchema = z.object({
  /** Stable within the verdict, e.g. "f1". */
  id: z.string(),
  severity: z.enum(["critical", "important", "minor"]),
  category: z.enum(["bug", "security", "performance", "tests", "design", "convention"]),
  file: z.string().nullable(),
  side: z.enum(["RIGHT", "LEFT"]),
  /** First line of a multi-line range; null for a single line. */
  startLine: z.number().int().min(1).nullable(),
  /** Line in the PR diff (new file for RIGHT); null = about the file or the PR as a whole. */
  line: z.number().int().min(1).nullable(),
  /** One line; becomes the comment's first line. */
  title: z.string(),
  /** Why it is wrong, markdown. */
  body: z.string(),
  /** Replacement for startLine..line, posted as a ```suggestion block. */
  suggestion: z.string().nullable(),
  confidence: z.enum(["high", "medium"]),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** What a review station returns (also its JSON schema). */
export const reviewVerdictSchema = z.object({
  recommendation: z.enum(["approve", "comment", "request_changes"]),
  /** 2–5 sentences: what the PR does and what matters. */
  summary: z.string(),
  /** Most severe first. */
  findings: z.array(reviewFindingSchema).max(30),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

const { $schema: _reviewDialect, ...reviewVerdictJsonSchema } = z.toJSONSchema(
  reviewVerdictSchema,
  { target: "draft-7" },
);
export const REVIEW_VERDICT_JSON_SCHEMA: Record<string, unknown> = reviewVerdictJsonSchema;

/** Starts a ZASTAVA review of the PR's current head. */
export const startReviewSchema = z.object({
  /** Client-generated work order id makes the start idempotent. */
  id: z.uuid().optional(),
});
export type StartReview = z.infer<typeof startReviewSchema>;

/** The latest ZASTAVA review of a PR. */
export const zastavaReviewSchema = z.object({
  workOrderId: z.uuid(),
  runId: z.uuid().nullable(),
  status: runStatusSchema,
  costUsd: z.number(),
  pullRequest: reviewPullRequestSchema,
  /** The PR head moved since the review ran. */
  stale: z.boolean(),
  verdict: reviewVerdictSchema.nullable(),
  error: z.string().nullable(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type ZastavaReview = z.infer<typeof zastavaReviewSchema>;

export const zastavaReviewResultSchema = z.object({ review: zastavaReviewSchema.nullable() });
export type ZastavaReviewResult = z.infer<typeof zastavaReviewResultSchema>;

/** Findings the human kept, as edited; they go to the pending review. */
export const postFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().trim().min(1).max(300),
        body: z.string().max(20_000),
        suggestion: z.string().max(20_000).nullable(),
      }),
    )
    .min(1)
    .max(30),
});
export type PostFindings = z.infer<typeof postFindingsSchema>;

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
  "knowledge_sources",
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
    // Plans with the project's knowledge sources when it has any (spec 0007).
    useKnowledge: true,
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

// ── Review line (spec 0009) ─────────────────────────────────────────────────

/** A review line only reads: no station edits code, works in shifts or waits at a gate. */
export const updateReviewLineSchema = updateLineSchema.refine(
  ({ stations }) =>
    stations.every(
      (s) => s.kind !== "gate" && s.kind !== "shift" && (s.kind !== "agent" || !s.canEdit),
    ),
  { message: "a review line has no gates, shifts or stations that edit code", path: ["stations"] },
);

/** The review line every project starts with: one read-only reviewer. */
export const REVIEW_LINE_STATIONS: Station[] = [
  {
    key: "review",
    kind: "agent",
    name: "Review",
    role: "pull-request-reviewer",
    model: "claude-sonnet-5-5",
    effort: "high",
    maxBudgetUsd: 3,
    allowedTools: [...READ_ONLY_TOOLS, "Bash"],
    canEdit: false,
    structuredVerdict: "review",
    useKnowledge: true,
    prompt: [
      "You are a senior reviewer on this team, reviewing someone's pull request. The working tree is the PR's head commit; the brief at .zastava/review-brief.md has the PR, the base and head commits, the changed files and the open threads.",
      "Read the diff (git diff <base>...<head>) and as much surrounding code as you need to be sure. Never modify files.",
      "Report only real problems a careful teammate would block or fix before merge: bugs, broken edge cases, security, data loss, races, missing or wrong tests for changed behaviour, and clear violations of this repo's own conventions (CLAUDE.md, knowledge). No style nits a linter or formatter catches, no praise, no restating what the code does, nothing already said in an open thread.",
      "Every finding points at a line the PR added or changed: file, line (new file, side RIGHT; side LEFT only for removed lines), startLine for a range. Title is one line. Body says why it is wrong and what to do. Give a suggestion (the exact replacement lines for startLine..line) only when the fix is local and certain.",
      "Only emit findings you are at least fairly sure about (confidence high or medium). Fewer, sharper findings beat many weak ones; an empty findings array is the right answer for a clean PR. Order findings most severe first; ids f1, f2, ….",
      "recommendation: request_changes if any critical finding, comment if only important/minor ones, approve if none. summary: 2–5 sentences on what the PR does and what matters most.",
    ].join("\n\n"),
  },
];
