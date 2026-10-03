// Pure helpers for the reviewRun workflow — deterministic, no I/O.
import type {
  AgentStation,
  ChecksStation,
  KnowledgeMount,
  PreviousFinding,
  ReviewFinding,
  ReviewVerdict,
} from "@zastava/contracts";
import { knowledgeSection, type StationNote } from "./line-logic";

/** Check output in a finding: the tail is what explains a failure. */
const MAX_OUTPUT_CHARS = 4_000;
const MAX_NOTE_CHARS = 8_000;
const RANK = { critical: 0, important: 1, minor: 2 } as const;

const tail = (text: string, max: number): string =>
  text.length > max ? `…${text.slice(-max)}` : text;

/** How the review text reads in the PR panel and on GitHub, whatever the station's own prompt says. */
const REVIEW_OUTPUT_FORMAT = [
  "## Output format",
  "`summary`: first line, one sentence on what the PR does. Then a blank line and 2–4 short `- ` bullets: what matters most, what you checked, and what you did not verify. Short lines, no wall of text.",
  "Each finding `body`: markdown for a GitHub comment. Lead with the problem in one or two sentences, then a blank line and the fix. Use `code` for identifiers and short bullets when there are several points.",
].join("\n\n");

/** A re-review answers "did they fix what I asked for?" first (spec 0010). */
const RE_REVIEW_RULES = [
  "## Previous findings",
  "The brief lists the previous review's findings. Give every one an entry in `previous`: its `id`, `status` (`fixed`, `partly` or `open`) and `note`, one line of evidence such as `file:line` or a commit.",
  "Judge each on the head commit, not the old one: lines may have moved, and a finding is fixed when the problem is gone, whatever the fix looks like.",
  "Never repeat a previous finding in `findings`: `findings` holds new problems only.",
  "The `summary` says what changed since the last review and what is still open.",
].join("\n\n");

export function buildReviewPrompt(
  run: { title: string; pullRequest: { number: number; url: string; previousFindings?: number } },
  station: AgentStation,
  notes: StationNote[],
  knowledge: KnowledgeMount[] = [],
): string {
  const history = notes
    .map((note) => `### ${note.station}\n${tail(note.text, MAX_NOTE_CHARS)}`)
    .join("\n\n");
  return [
    `# Pull request review: #${run.pullRequest.number} ${run.title}`,
    run.pullRequest.url,
    "Read `.zastava/review-brief.md` first: the diff range, the changed files, the description and the threads already open. `.zastava/` is ZASTAVA's, not part of the PR.",
    "The working tree is the PR's head commit, detached. Never modify, commit or push anything.",
    history ? `## Earlier stations\n\n${history}` : "",
    knowledgeSection(knowledge),
    `## Your station: ${station.name} (${station.role})`,
    REVIEW_OUTPUT_FORMAT,
    (run.pullRequest.previousFindings ?? 0) > 0 ? RE_REVIEW_RULES : "",
    "Review the pull request now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A failing checks station as a finding about the PR as a whole. */
export function checksFinding(station: ChecksStation, output: string, n: number): ReviewFinding {
  return {
    id: `c${n}`,
    severity: "important",
    category: "tests",
    file: null,
    side: "RIGHT",
    startLine: null,
    line: null,
    title: `${station.name} fails on this PR (\`${station.command}\`)`,
    body: `\`${station.command}\` exits non-zero on the PR's head:\n\n\`\`\`\n${tail(output.trim(), MAX_OUTPUT_CHARS)}\n\`\`\``,
    suggestion: null,
    confidence: "high",
  };
}

/** A QA station that failed (or could not run) as a finding. */
export function qaFinding(
  name: string,
  result: { status: "failed" | "error"; summary: string; report: string },
  n: number,
): ReviewFinding {
  const failed = result.status === "failed";
  return {
    id: `q${n}`,
    severity: failed ? "important" : "minor",
    category: "design",
    file: null,
    side: "RIGHT",
    startLine: null,
    line: null,
    title: failed ? `${name}: the running app has problems` : `${name} could not run`,
    body: failed ? tail(result.report || result.summary, MAX_OUTPUT_CHARS) : result.summary,
    suggestion: null,
    confidence: failed ? "high" : "medium",
  };
}

/**
 * The reviewer's verdict plus what checks and QA found, most severe first.
 * Extra findings can only make the recommendation stricter.
 */
export function mergeFindings(verdict: ReviewVerdict, extra: ReviewFinding[]): ReviewVerdict {
  // Idempotent: a retried completeReview finds its extras already merged.
  const fresh = extra.filter((e) => !verdict.findings.some((f) => f.id === e.id));
  if (fresh.length === 0) return verdict;
  const findings = [...verdict.findings, ...fresh].toSorted(
    (a, b) => RANK[a.severity] - RANK[b.severity],
  );
  const recommendation = findings.some((f) => f.severity === "critical")
    ? "request_changes"
    : verdict.recommendation === "approve" && findings.length > 0
      ? "comment"
      : verdict.recommendation;
  return { ...verdict, recommendation, findings };
}

/**
 * Keeps one status per previous finding the re-review knows (unknown ids and
 * repeats are dropped; a missing one shows as "not checked"). A critical
 * finding that is not fixed, previous or new, means request changes.
 */
export function reconcilePrevious(
  verdict: ReviewVerdict,
  previousFindings: PreviousFinding[],
): ReviewVerdict {
  const severity = new Map(previousFindings.map((f) => [f.id, f.severity]));
  const seen = new Set<string>();
  const previous = verdict.previous.filter((p) => {
    if (!severity.has(p.id) || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  const criticalOpen =
    verdict.findings.some((f) => f.severity === "critical") ||
    previous.some((p) => p.status !== "fixed" && severity.get(p.id) === "critical");
  return {
    ...verdict,
    previous,
    recommendation: criticalOpen ? "request_changes" : verdict.recommendation,
  };
}
