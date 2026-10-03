// Pure helpers for the reviewRun workflow — deterministic, no I/O.
import type {
  AgentStation,
  ChecksStation,
  KnowledgeMount,
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

export function buildReviewPrompt(
  run: { title: string; pullRequest: { number: number; url: string } },
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
