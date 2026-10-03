// Pure helpers shared by the workflow — deterministic, no I/O.
import type { AgentStation, Verdict } from "@zastava/contracts";

/** Builder re-runs allowed per run, across validator and checks failures. */
export const MAX_FIX_LOOPS = 2;
/** Earlier stations' output is context, not gospel; cap it so prompts stay small. */
const MAX_NOTE_CHARS = 12_000;

export interface StationNote {
  station: string;
  text: string;
}

/**
 * Only verdict-producing stations can fail the line. Structured verdicts are
 * authoritative; the text marker is the fallback for free-form validators.
 */
export function validatorPassed(
  station: AgentStation,
  result: { output: string; verdict?: Verdict | null },
): boolean {
  if (result.verdict) return result.verdict.verdict === "pass";
  if (station.structuredVerdict) return true;
  return !result.output.trimStart().startsWith("VERDICT: FAIL");
}

export function buildPrompt(
  run: { title: string; description: string; branch: string },
  station: AgentStation,
  notes: StationNote[],
): string {
  const history = notes
    .map((note) => `### ${note.station}\n${note.text.slice(0, MAX_NOTE_CHARS)}`)
    .join("\n\n");
  return [
    `# Work order: ${run.title}`,
    run.description || "(no description)",
    `You are working in a git worktree on branch \`${run.branch}\`.`,
    "`.zastava/` (goal, tasks.json, progress) is ZASTAVA's working memory: it is excluded from git and from the diff by design, so never report it as missing or part of the change.",
    history ? `## Previous stations\n\n${history}` : "",
    `## Your station: ${station.name} (${station.role})`,
    "Do your station's job now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Prompt for a resumed session: it already holds its earlier work, so send
 * only what changed. A read-only station (research) revises its output.
 */
export function buildFollowUp(reason: StationNote, canEdit = true): string {
  return [
    "The work came back to you.",
    `### ${reason.station}\n${reason.text.slice(0, MAX_NOTE_CHARS)}`,
    canEdit
      ? "Address this now in the same worktree, then summarize what you changed."
      : "Revise your work to address this. Do not modify any files. End with the complete revised result (for a plan: the full revised plan as a numbered list), not only the differences.",
  ].join("\n\n");
}
