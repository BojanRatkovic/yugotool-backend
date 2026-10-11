import type {
  PostFindings,
  PreviousFinding,
  PrLineCommentInput,
  ReviewFinding,
  ReviewPullRequest,
} from "@yugotool/contracts";

/** The findings a human kept, as GitHub writes: line comments and a summary addition. */
export interface PendingReviewPlan {
  comments: PrLineCommentInput[];
  /** Finding id per comment, same order. */
  commentIds: string[];
  body: string | null;
  bodyIds: string[];
}

type Edit = PostFindings["findings"][number];

function commentBody(edit: Edit): string {
  const parts = [`**${edit.title.trim()}**`];
  if (edit.body.trim()) parts.push(edit.body.trim());
  if (edit.suggestion !== null) parts.push(`\`\`\`suggestion\n${edit.suggestion}\n\`\`\``);
  return parts.join("\n\n");
}

/**
 * Line findings become line comments at the review's anchors (the human edits
 * text, never anchors); the rest become one block for the review summary.
 * Edits for ids the verdict doesn't have are ignored and reported back.
 */
export function planPendingReview(
  findings: ReviewFinding[],
  edits: Edit[],
): { plan: PendingReviewPlan; unknown: string[] } {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const plan: PendingReviewPlan = { comments: [], commentIds: [], body: null, bodyIds: [] };
  const notes: string[] = [];
  const unknown: string[] = [];
  for (const edit of edits) {
    const finding = byId.get(edit.id);
    if (!finding) {
      unknown.push(edit.id);
      continue;
    }
    if (finding.file && finding.line !== null) {
      plan.comments.push({
        path: finding.file,
        line: finding.line,
        side: finding.side,
        ...(finding.startLine !== null
          ? { startLine: finding.startLine, startSide: finding.side }
          : {}),
        body: commentBody(edit),
      });
      plan.commentIds.push(edit.id);
    } else {
      const where = finding.file ? ` (\`${finding.file}\`)` : "";
      // A suggestion without a line can't apply: plain code in the summary.
      const text = commentBody({ ...edit, suggestion: null });
      const code = edit.suggestion === null ? "" : `\n\n\`\`\`\n${edit.suggestion}\n\`\`\``;
      notes.push(`${text.replace(/^\*\*(.*?)\*\*/, `**$1**${where}`)}${code}`);
      plan.bodyIds.push(edit.id);
    }
  }
  if (notes.length > 0) plan.body = notes.join("\n\n---\n\n");
  return { plan, unknown };
}

type OpenThread = ReviewPullRequest["openThreads"][number];

/**
 * A re-review checks the previous done review's findings (spec 0010): each one
 * is frozen with its thread and that thread's state on GitHub now. Their threads
 * leave `openThreads`, which the reviewer reads as "already raised, do not repeat".
 */
export function freezePrevious(
  last: { pullRequest: ReviewPullRequest; findings: ReviewFinding[] } | null,
  snapshot: {
    openThreads: (OpenThread & { id: string })[];
    threadResolved: Record<string, boolean>;
  },
): { previousFindings: PreviousFinding[]; openThreads: OpenThread[] } {
  const posted = new Set(last?.pullRequest.posted ?? []);
  const threads = last?.pullRequest.postedThreads ?? {};
  const previousFindings = (last?.findings ?? []).slice(0, 30).map((f) => {
    const threadId = threads[f.id] ?? null;
    return {
      id: f.id,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      title: f.title,
      body: f.body,
      posted: posted.has(f.id),
      threadId,
      threadResolved: threadId === null ? null : (snapshot.threadResolved[threadId] ?? null),
    };
  });
  const mine = new Set(previousFindings.flatMap((f) => (f.threadId ? [f.threadId] : [])));
  return {
    previousFindings,
    openThreads: snapshot.openThreads
      .filter((t) => !mine.has(t.id))
      .map(({ id: _id, ...thread }) => thread),
  };
}
