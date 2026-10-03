import type { ReviewFinding } from "@zastava/contracts";

interface Range {
  start: number;
  end: number;
}

/** Per file: line ranges GitHub accepts comments on, per side of the diff. */
export type DiffHunks = Map<string, { RIGHT: Range[]; LEFT: Range[] }>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Hunk ranges from a unified diff (`git diff --unified=3`, as GitHub shows a
 * PR). A comment is valid on any line inside a hunk, context lines included.
 */
export function parseHunks(patch: string): DiffHunks {
  const hunks: DiffHunks = new Map();
  let current: { RIGHT: Range[]; LEFT: Range[] } | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      const file = target.replace(/^b\//, "");
      current = hunks.get(file) ?? { RIGHT: [], LEFT: [] };
      hunks.set(file, current);
    } else if (current) {
      const match = HUNK.exec(line);
      if (!match) continue;
      const [, oldStart, oldCount, newStart, newCount] = match;
      const left = Number(oldCount ?? "1");
      const right = Number(newCount ?? "1");
      if (left > 0) {
        current.LEFT.push({ start: Number(oldStart), end: Number(oldStart) + left - 1 });
      }
      if (right > 0) {
        current.RIGHT.push({ start: Number(newStart), end: Number(newStart) + right - 1 });
      }
    }
  }
  return hunks;
}

const hunkOf = (ranges: Range[], line: number): Range | undefined =>
  ranges.find((r) => line >= r.start && line <= r.end);

/** A suggestion that can no longer apply to its lines travels in the body as plain code. */
function suggestionInBody(finding: ReviewFinding): ReviewFinding {
  if (!finding.suggestion) return finding;
  return {
    ...finding,
    suggestion: null,
    body: `${finding.body}\n\nSuggested change:\n\n\`\`\`\n${finding.suggestion}\n\`\`\``,
  };
}

function unanchor(finding: ReviewFinding, keepFile: boolean): ReviewFinding {
  return {
    ...suggestionInBody(finding),
    file: keepFile ? finding.file : null,
    line: null,
    startLine: null,
  };
}

/**
 * Keeps a finding's line anchor only where GitHub will take a line comment:
 * inside a hunk of the PR diff, on the finding's side. A range that crosses
 * hunks shrinks to its last line. Everything else goes to the review body.
 */
export function anchorFindings(findings: ReviewFinding[], hunks: DiffHunks): ReviewFinding[] {
  return findings.map((finding) => {
    if (!finding.file || finding.line === null) return finding;
    const file = hunks.get(finding.file);
    if (!file) return unanchor(finding, false);
    const ranges = file[finding.side];
    const hunk = hunkOf(ranges, finding.line);
    if (!hunk) return unanchor(finding, true);
    if (finding.startLine === null) return finding;
    const start = finding.startLine;
    if (start < finding.line && start >= hunk.start) return finding;
    // A suggestion replaces the whole range: on the shrunk range it would misapply.
    return { ...suggestionInBody(finding), startLine: null };
  });
}
