// Research in a hub project (spec 0014): it runs in the hub itself, read-only,
// picks the repo the work goes in and may propose a split across repos.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ResearchPlan, SplitItem, StationResearch } from "@yugotool/contracts";

const exec = promisify(execFile);

// ── Repo sync ───────────────────────────────────────────────────────────────

export interface CheckoutState {
  /** The checked-out branch; empty when detached. */
  branch: string;
  baseBranch: string;
  /** Tracked files changed (untracked files don't block a fast-forward). */
  dirty: boolean;
  /** `origin/<base>` exists after the fetch. */
  hasRemoteBase: boolean;
}

/**
 * Whether a `repos/<name>` checkout may be fast-forwarded: only when it is
 * clean and on its base branch. A person's switched or dirty checkout is
 * never touched. Pure.
 */
export function syncDecision(state: CheckoutState): { ff: true } | { ff: false; reason: string } {
  if (!state.hasRemoteBase) return { ff: false, reason: `no origin/${state.baseBranch}` };
  if (state.branch !== state.baseBranch) {
    return { ff: false, reason: state.branch ? `on ${state.branch}` : "detached HEAD" };
  }
  if (state.dirty) return { ff: false, reason: "uncommitted changes" };
  return { ff: true };
}

export interface RepoSyncResult {
  name: string;
  /** "updated abc1234..def5678", "up to date", or why it was skipped. */
  outcome: string;
  skipped: boolean;
}

const SYNC_REUSE_MS = 2 * 60_000;
const syncs = new Map<
  string,
  { startedAt: number; done: boolean; result: Promise<RepoSyncResult[]> }
>();

/**
 * One sync per hub at a time: runs started together share it (three
 * concurrent syncs raced on the same checkouts: "git failed", a half-merged
 * repo reported as "uncommitted changes"), and a sync from the last two
 * minutes is reused.
 */
export function syncHubReposShared(
  hub: string,
  repos: { name: string; baseBranch: string }[],
  now = Date.now(),
): Promise<RepoSyncResult[]> {
  const last = syncs.get(hub);
  if (last && (!last.done || now - last.startedAt < SYNC_REUSE_MS)) return last.result;
  const entry = { startedAt: now, done: false, result: syncHubRepos(hub, repos) };
  entry.result = entry.result.finally(() => {
    entry.done = true;
  });
  syncs.set(hub, entry);
  return entry.result;
}

/** Fetches each hub repo and fast-forwards the clean ones on their base branch. */
export async function syncHubRepos(
  hub: string,
  repos: { name: string; baseBranch: string }[],
): Promise<RepoSyncResult[]> {
  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    const dir = path.join(hub, "repos", repo.name);
    const git = (...args: string[]) =>
      exec("git", ["-C", dir, ...args], { timeout: 120_000 }).then(({ stdout }) => stdout.trim());
    try {
      await git("fetch", "--quiet", "origin").catch(() => undefined);
      const state: CheckoutState = {
        branch: await git("branch", "--show-current"),
        baseBranch: repo.baseBranch,
        dirty: (await git("status", "--porcelain", "--untracked-files=no")) !== "",
        hasRemoteBase: await git(
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${repo.baseBranch}`,
        ).then(
          () => true,
          () => false,
        ),
      };
      const decision = syncDecision(state);
      if (!decision.ff) {
        results.push({ name: repo.name, outcome: decision.reason, skipped: true });
        continue;
      }
      const before = await git("rev-parse", "--short", "HEAD");
      await git("merge", "--ff-only", "--quiet", `origin/${repo.baseBranch}`);
      const after = await git("rev-parse", "--short", "HEAD");
      results.push({
        name: repo.name,
        outcome: before === after ? "up to date" : `updated ${before}..${after}`,
        skipped: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: repo.name,
        outcome: /not possible to fast-forward|diverg/i.test(message)
          ? "diverged from origin"
          : "git failed",
        skipped: true,
      });
    }
  }
  return results;
}

/** One event line for the sync. Pure. */
export function describeSync(results: RepoSyncResult[]): string {
  const done = results.filter((r) => !r.skipped).map((r) => `${r.name} ${r.outcome}`);
  const skipped = results.filter((r) => r.skipped).map((r) => `${r.name} (${r.outcome})`);
  return [
    "Hub repos synced",
    done.length ? done.join(", ") : null,
    skipped.length ? `skipped ${skipped.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/** Appended to the system prompt of read-only stations running in the hub. Pure. */
export function hubResearchPrompt(input: {
  hub: string;
  repos: string[];
  presetRepo: string | null;
  /** The station that returns the plan (structured: plan, repo, split). */
  plans: boolean;
}): string {
  const list = input.repos.map((r) => `\`repos/${r}\``).join(", ");
  return [
    "## Work hub",
    `You are in the work hub at \`${input.hub}\` (your working directory). Its CLAUDE.md/AGENTS.md (already loaded), knowledge, specs and skills apply: read what is relevant. The code lives in clean, freshly updated checkouts: ${list}.`,
    "Do not modify anything and do not create worktrees, branches or pull requests: YugoTool prepares a worktree for the chosen repo after the plan is approved.",
    "Plan only the change and how to verify it locally. Leave committing, pushing and opening a pull request out of the plan (no `/p-dev:open-pr`-style steps): YugoTool delivers the work after the final review.",
    input.plans
      ? input.presetRepo
        ? `This work order is set to \`${input.presetRepo}\`: set \`repo\` to it and plan the work there. Propose a \`split\` only if other repos must change too.`
        : "Pick the one repo whose code must change (where the builder will edit, not where you only read context) and set `repo` to its name (one of the names above, without `repos/`)."
      : null,
    input.plans
      ? "If more than one repo must change, propose a `split`: one work order per repo, in the order they must land (each with `title`, `description` holding that part of the plan, and `repo`); `repo` is then the first item's repo. Put the complete plan, as a numbered list, in `plan`."
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── Result ──────────────────────────────────────────────────────────────────

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A hub repo by its exact or case-insensitive name. */
function known(name: string, repos: string[]): string | null {
  const trimmed = name
    .trim()
    .replace(/^repos\//, "")
    .replace(/\/+$/, "");
  return (
    repos.find((r) => r === trimmed) ??
    repos.find((r) => r.toLowerCase() === trimmed.toLowerCase()) ??
    null
  );
}

/** The repo a text mentions first (as a whole word), else null. Pure. */
export function firstMentioned(text: string, repos: string[]): string | null {
  let best: { repo: string; at: number } | null = null;
  // Longer names first, so `shop-backend` wins over a repo called `shop`.
  for (const repo of repos.toSorted((a, b) => b.length - a.length)) {
    const match = new RegExp(`(^|[^A-Za-z0-9_-])${escape(repo)}(?![A-Za-z0-9_-])`, "i").exec(text);
    if (!match) continue;
    const at = match.index + match[1]!.length;
    if (!best || at < best.at) best = { repo, at };
  }
  return best?.repo ?? null;
}

/**
 * Research's answer checked against the hub's repos. A preset repo wins; a
 * name the hub doesn't have falls back to the first repo the plan mentions,
 * else null (the plan gate asks). A split whose repos can't all be resolved,
 * or with fewer than two items, is dropped. Pure.
 */
export function resolveResearch(
  plan: ResearchPlan,
  repos: string[],
  presetRepo: string | null,
): StationResearch {
  const split = resolveSplit(plan.split, repos);
  const repo =
    (presetRepo && known(presetRepo, repos)) ??
    split?.[0]?.repo ??
    known(plan.repo, repos) ??
    firstMentioned(plan.plan, repos);
  return { plan: plan.plan, repo, ...(split ? { split } : {}) };
}

function resolveSplit(items: SplitItem[] | undefined, repos: string[]): SplitItem[] | null {
  if (!items || items.length < 2) return null;
  const resolved = items.map((item) => {
    const repo =
      known(item.repo, repos) ?? firstMentioned(`${item.title}\n${item.description}`, repos);
    return repo ? { ...item, repo } : null;
  });
  return resolved.every((i) => i !== null) ? resolved : null;
}

/**
 * The plan when Research ended without a structured answer: its longest text
 * of the session (the model sometimes ends on "I already sent the plan"),
 * else the final result. Pure.
 */
export function fallbackPlan(texts: string[], result: string): string {
  const longest = texts.reduce((best, text) => (text.length > best.length ? text : best), "");
  return longest.length > result.length ? longest : result;
}

/** The station's output line: the plan, prefixed with the repo it goes in. Pure. */
export function researchOutput(research: StationResearch): string {
  const head = research.split
    ? `Repo: ${research.repo ?? "?"} · split into ${research.split.length} work orders (${research.split.map((s) => s.repo).join(" → ")})`
    : `Repo: ${research.repo ?? "not chosen — pick one at the plan gate"}`;
  return `${head}\n\n${research.plan}`;
}
