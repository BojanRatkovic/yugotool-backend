// Which repo a hub run's plan gate approves (spec 0014). Pure.
import type { GateDecision } from "@zastava/contracts";

export interface HubGateContext {
  kind: "repo" | "hub";
  /** The run's repo once its worktree exists; null before. */
  runRepo: string | null;
  /** The work order's preset repo. */
  presetRepo: string | null;
  /** The repo the latest planning station chose, if any. */
  researchRepo: string | null;
  /** The hub's repos, by name. */
  repos: string[];
}

/** Null when the decision is fine; otherwise why it is refused. */
export function gateRepoProblem(ctx: HubGateContext, decision: GateDecision): string | null {
  if (decision.repo !== undefined) {
    if (ctx.kind !== "hub") return "only hub projects choose a repo at a gate";
    if (ctx.runRepo !== null) {
      return `this run already works in ${ctx.runRepo}; the repo is chosen before the worktree exists`;
    }
    if (!ctx.repos.includes(decision.repo)) {
      return `${decision.repo} is not a repo of this hub (${ctx.repos.join(", ")})`;
    }
    return null;
  }
  const unchosen =
    ctx.kind === "hub" &&
    ctx.runRepo === null &&
    ctx.presetRepo === null &&
    ctx.researchRepo === null;
  if (decision.decision === "approve" && unchosen) {
    return "Research named no repo of this hub: pick the repo to approve the plan";
  }
  return null;
}
