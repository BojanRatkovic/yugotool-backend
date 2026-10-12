// Pure: which skills a station session loads first (spec 0015).
import { skillMentions } from "@yugotool/contracts";

export interface SkillPlan {
  /** Skills to load, in order: the station's own, then those the text names. */
  load: string[];
  /** The station's own skills this session cannot load (not in this checkout). */
  missing: string[];
}

/**
 * The station's "always load" skills plus every known `/skill` the prompt
 * names (the work order, a gate note, the plan), limited to what the session
 * can actually load.
 */
export function skillPlan(
  configured: readonly string[],
  text: string,
  available: readonly string[],
): SkillPlan {
  const known = new Set(available);
  const load = [
    ...new Set([...configured.filter((s) => known.has(s)), ...skillMentions(text, available)]),
  ];
  return { load, missing: configured.filter((s) => !known.has(s)) };
}

/** The system prompt section that asks for them. Null when there are none. Pure. */
export function skillSection(load: readonly string[]): string | null {
  if (load.length === 0) return null;
  return [
    "## Skills for this work",
    `Before you start, load each of these with the Skill tool and follow them: ${load.map((s) => `\`${s}\``).join(", ")}. A \`/name\` in the task means that skill.`,
  ].join("\n\n");
}

/** The run-event line saying which skills a session loads and which it can't. Null for none. Pure. */
export function skillNote(plan: SkillPlan): string | null {
  const parts = [
    plan.load.length ? `Skills to load: ${plan.load.join(", ")}` : null,
    plan.missing.length ? `not available here: ${plan.missing.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
