// Pure helpers for shift stations — deterministic, no I/O (imported by the workflow).
import {
  type AgentStation,
  DEFAULT_SHIFT_SETTINGS,
  type Handoff,
  type ShiftStation,
} from "@zastava/contracts";

/** Used until the session reports its real window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** progress.md entries replayed into a new shift's prompt. */
const PROGRESS_ENTRIES_IN_PROMPT = 3;
/** Idle shifts in a row that count as stuck. */
export const STUCK_AFTER_IDLE_SHIFTS = 2;

export interface ShiftTally {
  commits: number;
  tasksDone: number;
}

/** Room a shift gets for real work even when the session starts above the line. */
export const MIN_WORK_TOKENS = 15_000;

/**
 * The handoff point in tokens. Claude Code's own system prompt, tools and
 * CLAUDE.md can already fill a third of the window before the first tool call;
 * a line below that baseline would hand off before any work, so it moves up.
 */
export function effectiveHandoffTokens(
  handoffAtPct: number,
  contextWindow: number,
  baseline: number,
): { tokens: number; raised: boolean } {
  const configured = handoffThreshold(handoffAtPct, contextWindow);
  const floor = baseline + MIN_WORK_TOKENS;
  return configured >= floor
    ? { tokens: configured, raised: false }
    : { tokens: floor, raised: true };
}

/** Tokens at which a shift hands off. */
export function handoffThreshold(handoffAtPct: number, contextWindow: number): number {
  return Math.floor((handoffAtPct / 100) * contextWindow);
}

export function contextPct(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0;
}

/**
 * Stuck = the last two shifts changed no code (no commits). Task counts are
 * not progress: an agent facing an impossible goal keeps adding a task and
 * ticking it off. A planning-only first shift happens once, so two in a row
 * still means nothing moved.
 */
export function isStuck(history: ShiftTally[]): boolean {
  if (history.length < STUCK_AFTER_IDLE_SHIFTS) return false;
  return history.slice(-STUCK_AFTER_IDLE_SHIFTS).every((shift) => shift.commits === 0);
}

/** A loop-back (validator, checks or reviewer) becomes the next shift's handoff. */
export function handoffFromFeedback(source: string, report: string): Handoff {
  return {
    summary: `The work came back from ${source}. Address the report below before anything else.`,
    done: [],
    inProgress: null,
    nextSteps: [report],
    gotchas: [],
    filesToRead: [],
  };
}

const list = (items: string[]): string =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

export function renderHandoff(handoff: Handoff): string {
  return [
    handoff.summary,
    `**Done**\n${list(handoff.done)}`,
    `**In progress**\n${handoff.inProgress ?? "(nothing half-done)"}`,
    `**Next steps**\n${handoff.nextSteps.map((step, i) => `${i + 1}. ${step}`).join("\n") || "(none)"}`,
    `**Gotchas**\n${list(handoff.gotchas)}`,
    `**Files to read first**\n${list(handoff.filesToRead)}`,
  ].join("\n\n");
}

/** The progress.md entry for one shift. */
export function renderProgressEntry(input: {
  number: number;
  endReason: string;
  contextPct: number;
  handoff: Handoff | null;
  output: string;
}): string {
  const head = `## Shift ${input.number} · ${input.endReason} · ${input.contextPct}% context`;
  const body = input.handoff ? renderHandoff(input.handoff) : input.output.trim() || "(no summary)";
  return `${head}\n\n${body}\n`;
}

/** The last `count` "## Shift" entries of progress.md. */
export function lastProgressEntries(progress: string, count = PROGRESS_ENTRIES_IN_PROMPT): string {
  const entries = progress.split(/^(?=## Shift )/m).filter((e) => e.startsWith("## Shift "));
  return entries.slice(-count).join("\n").trim();
}

/** What an editing station's shifts aim for: its normal job, with no done command. */
export const BUILD_SHIFT_GOAL =
  "Do your station's job for the work order above, following the approved plan if there is one, then stop and summarize the changed files.";

/**
 * The shift engine's view of an editing agent station (spec 0012): every
 * builder works in shifts, one session when the work fits. Done = the agent
 * ends on its own; checks and validators come after it in the line.
 */
export function asShiftStation(station: AgentStation): ShiftStation {
  return {
    key: station.key,
    kind: "shift",
    name: station.name,
    role: station.role,
    model: station.model,
    ...(station.effort ? { effort: station.effort } : {}),
    allowedTools: station.allowedTools,
    prompt: station.prompt,
    goal: BUILD_SHIFT_GOAL,
    doneCommand: null,
    handoffAtPct: station.handoffAtPct ?? DEFAULT_SHIFT_SETTINGS.handoffAtPct,
    maxShifts: station.maxShifts ?? DEFAULT_SHIFT_SETTINGS.maxShifts,
    ...(station.maxBudgetUsd ? { maxBudgetUsd: station.maxBudgetUsd } : {}),
    reviewHandoff: station.reviewHandoff ?? DEFAULT_SHIFT_SETTINGS.reviewHandoff,
  };
}

/** Context room a resumed session must have left, in points below the handoff line. */
export const RESUME_HEADROOM_PCT = 10;

/**
 * Work coming back to an editing station resumes its last session (it holds
 * the context, a fresh shift re-reads everything) when that session finished
 * its work and still has room; otherwise a new shift starts from the report.
 */
export function canResumeShift(
  last: { endReason: string; sessionId: string | null; contextPct: number } | undefined,
  handoffAtPct: number,
): last is { endReason: "done"; sessionId: string; contextPct: number } {
  if (!last || last.endReason !== "done" || !last.sessionId) return false;
  return last.contextPct <= handoffAtPct - RESUME_HEADROOM_PCT;
}

export function renderGoal(input: {
  title: string;
  description: string;
  station: ShiftStation;
  /** An editing station's full brief (work order + earlier stations); replaces title/description. */
  brief?: string;
}): string {
  return [
    `# Goal`,
    ...(input.brief
      ? [input.brief]
      : [`## Work order: ${input.title}`, input.description || "(no description)"]),
    `## Station goal\n${input.station.goal}`,
    input.station.doneCommand
      ? `## Done check\n\`${input.station.doneCommand}\` exits 0 when the goal is met.`
      : "## Done check\nNo command: you decide when the goal is met, then stop.",
  ].join("\n\n");
}

export function buildShiftPrompt(input: {
  number: number;
  station: ShiftStation;
  goal: string;
  previousHandoff: Handoff | null;
  recentProgress: string;
  gitLog: string;
}): string {
  const { station } = input;
  const start = input.previousHandoff
    ? `## Handoff from the previous shift\n\n${renderHandoff(input.previousHandoff)}`
    : '## First shift\nCreate `.zastava/tasks.json` from the goal: a JSON array of `{ id, title, status: "todo" | "doing" | "done", notes }`, small enough that each task is one focused step. Then start on the first task.';
  return [
    `# Shift ${input.number} of at most ${station.maxShifts}`,
    "You work in shifts. Your memory lives on disk, not in this conversation: `.zastava/goal.md`, `.zastava/tasks.json`, `.zastava/progress.md`, `.zastava/learnings.md`. When this session's context fills up you will be asked for a handoff and a fresh session continues from it.",
    input.goal,
    start,
    input.recentProgress ? `## Recent progress\n\n${input.recentProgress}` : "",
    input.gitLog ? `## git log --oneline -10\n\n\`\`\`\n${input.gitLog}\n\`\`\`` : "",
    "## How to work",
    [
      station.doneCommand
        ? `1. Start by running \`${station.doneCommand}\` to see the current state.`
        : "1. Start by checking the current state of the code against the tasks.",
      "2. Work through tasks.json in order; mark a task `doing` when you start it and `done` when it is finished and verified. Update tasks.json as you go — it is how the next shift knows where you are.",
      "3. Leave the code in a working state after each task. Do not commit; ZASTAVA commits a checkpoint at the end of every shift.",
      "4. Do not edit `.zastava/progress.md` or `.zastava/learnings.md`; ZASTAVA writes them from your handoff.",
      station.doneCommand
        ? `5. When every task is done and \`${station.doneCommand}\` passes, stop and summarize.`
        : "5. When every task is done, stop and summarize.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildHandoffPrompt(
  pct: number,
  reason: "threshold" | "manual" | "unfinished",
): string {
  const why =
    reason === "threshold"
      ? `Context is at ${pct}%. Stop working now.`
      : reason === "manual"
        ? "A human asked for a handoff now. Stop working."
        : "You stopped, but the goal is not met yet (the done check fails).";
  return [
    why,
    "1. Update `.zastava/tasks.json` so every task's status is accurate.",
    "2. Return the handoff for the next shift: a fresh session that has never seen this conversation. Be concrete and forward-looking — exact file paths, what is half-done, the next steps in order, and traps you hit. Do not describe the past beyond what the next shift needs.",
  ].join("\n\n");
}

/** Agents often hand back absolute paths; the handoff speaks worktree-relative ones. */
export function relativeToWorktree(file: string, worktreePath: string): string {
  const root = worktreePath.endsWith("/") ? worktreePath : `${worktreePath}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}
