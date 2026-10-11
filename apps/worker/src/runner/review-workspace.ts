import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ReviewPullRequest } from "@yugotool/contracts";

const exec = promisify(execFile);

/** Where the review brief goes in the worktree (`.yugotool/` is never committed). */
export const REVIEW_BRIEF_PATH = ".yugotool/review-brief.md";
/** Briefs list at most this many files per section; the agent can ask git for the rest. */
const MAX_FILES = 300;
/** Long thread comments are cut; the point is "this was said", not the full text. */
const MAX_THREAD_CHARS = 400;
/** A previous finding's body in the brief: enough to recognise it. */
const MAX_PREVIOUS_BODY_CHARS = 1_200;

/** The PR's head commit could not be fetched (force-pushed away, or no such PR). */
export class ReviewHeadMissingError extends Error {}

const git = (cwd: string, ...args: string[]) =>
  exec("git", ["-C", cwd, ...args], { maxBuffer: 20 * 1024 * 1024 });

const hasCommit = (cwd: string, sha: string): Promise<boolean> =>
  git(cwd, "cat-file", "-e", `${sha}^{commit}`).then(
    () => true,
    () => false,
  );

/**
 * Makes sure the PR's head, its base and (on a re-review) the previous head are
 * in the local repo. `refs/pull/<n>/head` also covers PRs from forks.
 */
export async function fetchPullRequest(
  repoPath: string,
  pr: Pick<ReviewPullRequest, "number" | "headOid" | "baseRefName" | "baseOid" | "sinceOid">,
): Promise<void> {
  await git(
    repoPath,
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/pull/${pr.number}/head:refs/yugotool/pull/${pr.number}`,
    `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`,
  );
  for (const sha of [pr.headOid, pr.baseOid, pr.sinceOid]) {
    if (!sha || (await hasCommit(repoPath, sha))) continue;
    // The ref moved on since the review started; GitHub still serves reachable commits by id.
    await git(repoPath, "fetch", "--quiet", "--no-tags", "origin", sha).catch(() => undefined);
    if (sha === pr.headOid && !(await hasCommit(repoPath, sha))) {
      throw new ReviewHeadMissingError(
        `Commit ${sha.slice(0, 7)} of PR #${pr.number} is not on GitHub any more (force-pushed?). Run the review again on the new head.`,
      );
    }
  }
}

/** Files changed between two commits as GitHub shows a PR: from their merge-base. */
export async function changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await git(cwd, "diff", "--name-status", `${from}...${to}`);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/\t/g, " "));
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  const { stdout } = await git(cwd, "merge-base", a, b);
  return stdout.trim();
}

export interface ReviewBriefInput {
  title: string;
  body: string;
  pr: Pick<
    ReviewPullRequest,
    | "number"
    | "url"
    | "headRefName"
    | "baseRefName"
    | "headOid"
    | "sinceOid"
    | "openThreads"
    | "previousFindings"
  >;
  /** Merge-base of base and head: what the PR diff starts from. */
  mergeBaseOid: string;
  files: string[];
  /** Files changed since the previous review's head; null on a first review. */
  sinceFiles: string[] | null;
}

const fileList = (files: string[]): string =>
  files.length === 0
    ? "_none_"
    : [
        ...files.slice(0, MAX_FILES).map((f) => `- ${f}`),
        ...(files.length > MAX_FILES ? [`- … ${files.length - MAX_FILES} more`] : []),
      ].join("\n");

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_THREAD_CHARS ? `${flat.slice(0, MAX_THREAD_CHARS)}…` : flat;
};

const trimmed = (text: string): string => {
  const flat = text.trim();
  return flat.length > MAX_PREVIOUS_BODY_CHARS
    ? `${flat.slice(0, MAX_PREVIOUS_BODY_CHARS)}…`
    : flat;
};

function previousFinding(f: ReviewPullRequest["previousFindings"][number]): string {
  const place = f.file ? ` · \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const state = !f.posted
    ? "Not posted."
    : f.threadId === null
      ? "Posted in the review summary."
      : f.threadResolved
        ? "Posted; the thread is resolved on GitHub."
        : "Posted; the thread is still open on GitHub.";
  return [
    `### ${f.id} · ${f.severity}${place}`,
    `**${oneLine(f.title)}**`,
    trimmed(f.body),
    `_${state}_`,
  ].join("\n\n");
}

/** The markdown brief the review station reads first. Pure. */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const { pr } = input;
  const range = `${input.mergeBaseOid}...${pr.headOid}`;
  const sections = [
    `# Review brief: PR #${pr.number}`,
    `**${input.title}**  \n${pr.url}`,
    `Branch \`${pr.headRefName}\` into \`${pr.baseRefName}\`. The working tree is the head commit \`${pr.headOid}\`.`,
    "## Diff",
    `The PR diff is \`git diff ${range}\` (merge-base to head, as GitHub shows it). Comment only on lines inside this diff.`,
    `### Changed files (${input.files.length})`,
    fileList(input.files),
  ];
  if (input.sinceFiles && pr.sinceOid) {
    sections.push(
      "## Re-review",
      `YugoTool reviewed this PR before at \`${pr.sinceOid}\`. Focus on what changed since: \`git diff ${pr.sinceOid}...${pr.headOid}\`. Older code only matters where the new commits touch it.`,
      `### Changed since the last review (${input.sinceFiles.length})`,
      fileList(input.sinceFiles),
    );
  }
  sections.push("## Description", input.body.trim() || "_No description._");
  if (pr.previousFindings.length > 0) {
    const at = (pr.sinceOid ?? pr.headOid).slice(0, 7);
    sections.push(
      "## Previous findings (check each one)",
      `YugoTool's last review (at \`${at}\`) raised these. Give each one a status in \`previous\`; lines are at \`${at}\` and may have moved.`,
      pr.previousFindings.map(previousFinding).join("\n\n"),
    );
  }
  sections.push(
    "## Open threads (already raised; do not repeat)",
    pr.openThreads.length === 0
      ? "_none_"
      : pr.openThreads
          .map(
            (t) => `- \`${t.path}${t.line ? `:${t.line}` : ""}\` @${t.author}: ${oneLine(t.body)}`,
          )
          .join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

export async function writeReviewBrief(worktreePath: string, brief: string): Promise<string> {
  const file = path.join(worktreePath, REVIEW_BRIEF_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, brief);
  return file;
}

/** The PR diff as GitHub shows it (merge-base to head, 3 lines of context). */
export async function pullRequestPatch(cwd: string, base: string, head: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, "diff", "--unified=3", `${base}...${head}`], {
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}
