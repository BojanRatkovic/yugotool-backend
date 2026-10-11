import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REVIEW_BRIEF_PATH,
  ReviewHeadMissingError,
  buildReviewBrief,
  changedFiles,
  fetchPullRequest,
  mergeBase,
  writeReviewBrief,
} from "./review-workspace";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** An "origin" with main and a PR head published as refs/pull/7/head, plus a clone of it. */
function github() {
  const upstream = mkdtempSync(path.join(tmpdir(), "yugotool-review-up-"));
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "config", "user.email", "t@yugotool.local");
  git(upstream, "config", "user.name", "t");
  commit(upstream, "a.txt", "base\n", "base");
  const clone = mkdtempSync(path.join(tmpdir(), "yugotool-review-clone-"));
  execFileSync("git", ["clone", "-q", upstream, clone]);
  git(upstream, "checkout", "-q", "-b", "feature");
  const first = commit(upstream, "b.txt", "one\n", "feature 1");
  const head = commit(upstream, "c.txt", "two\n", "feature 2");
  git(upstream, "update-ref", "refs/pull/7/head", head);
  git(upstream, "checkout", "-q", "main");
  const baseOid = commit(upstream, "d.txt", "moved\n", "base moved");
  return { upstream, clone, first, head, baseOid };
}

describe("fetchPullRequest", () => {
  it("fetches the PR head and the moved base into a clone that had neither", async () => {
    const gh = github();
    await fetchPullRequest(gh.clone, {
      number: 7,
      headOid: gh.head,
      baseRefName: "main",
      baseOid: gh.baseOid,
      sinceOid: null,
    });
    expect(git(gh.clone, "rev-parse", "refs/yugotool/pull/7")).toBe(gh.head);
    expect(git(gh.clone, "rev-parse", "origin/main")).toBe(gh.baseOid);
    // GitHub's view: merge-base to head, the base's own new commit left out.
    const base = await mergeBase(gh.clone, gh.baseOid, gh.head);
    expect(await changedFiles(gh.clone, base, gh.head)).toEqual(["A b.txt", "A c.txt"]);
    expect(await changedFiles(gh.clone, gh.first, gh.head)).toEqual(["A c.txt"]);
  });

  it("fails clearly when the head commit is gone", async () => {
    const gh = github();
    await expect(
      fetchPullRequest(gh.clone, {
        number: 7,
        headOid: "0123456789012345678901234567890123456789",
        baseRefName: "main",
        baseOid: gh.baseOid,
        sinceOid: null,
      }),
    ).rejects.toBeInstanceOf(ReviewHeadMissingError);
  });
});

describe("buildReviewBrief", () => {
  const pr = {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    headRefName: "feature",
    baseRefName: "main",
    headOid: "h".repeat(40),
    sinceOid: null,
    openThreads: [
      { path: "src/a.ts", line: 3, author: "ana", body: "Why\nnot a map?" },
      { path: "src/b.ts", line: null, author: "bo", body: "x".repeat(500) },
    ],
    previousFindings: [],
  };

  it("has the diff range, files, description and open threads", () => {
    const brief = buildReviewBrief({
      title: "Add paging",
      body: "Pages the list.",
      pr,
      mergeBaseOid: "m".repeat(40),
      files: ["M src/a.ts", "A src/b.ts"],
      sinceFiles: null,
    });
    expect(brief).toContain(`git diff ${"m".repeat(40)}...${"h".repeat(40)}`);
    expect(brief).toContain("- M src/a.ts");
    expect(brief).toContain("Pages the list.");
    expect(brief).toContain("`src/a.ts:3` @ana: Why not a map?");
    expect(brief).toContain(`${"x".repeat(400)}…`);
    expect(brief).not.toContain("## Re-review");
  });

  it("adds a re-review section with the files since the last review", () => {
    const brief = buildReviewBrief({
      title: "Add paging",
      body: "",
      pr: { ...pr, sinceOid: "s".repeat(40), openThreads: [] },
      mergeBaseOid: "m".repeat(40),
      files: ["M src/a.ts"],
      sinceFiles: ["M src/a.ts"],
    });
    expect(brief).toContain("## Re-review");
    expect(brief).toContain(`git diff ${"s".repeat(40)}...${"h".repeat(40)}`);
    expect(brief).toContain("_No description._");
  });

  it("lists previous findings to check, before the open threads", () => {
    const previous = {
      severity: "critical" as const,
      category: "bug",
      file: "src/a.ts",
      line: 12,
      title: "Null deref",
      body: "Guard the empty list.",
    };
    const brief = buildReviewBrief({
      title: "Add paging",
      body: "",
      pr: {
        ...pr,
        sinceOid: "s".repeat(40),
        previousFindings: [
          { ...previous, id: "f1", posted: true, threadId: "T1", threadResolved: false },
          {
            ...previous,
            id: "f2",
            file: null,
            line: null,
            posted: true,
            threadId: null,
            threadResolved: null,
          },
          {
            ...previous,
            id: "f3",
            body: "y".repeat(2_000),
            posted: false,
            threadId: null,
            threadResolved: null,
          },
        ],
      },
      mergeBaseOid: "m".repeat(40),
      files: ["M src/a.ts"],
      sinceFiles: ["M src/a.ts"],
    });
    expect(brief).toContain("## Previous findings (check each one)");
    expect(brief).toContain("### f1 · critical · `src/a.ts:12`");
    expect(brief).toContain("_Posted; the thread is still open on GitHub._");
    expect(brief).toContain("_Posted in the review summary._");
    expect(brief).toContain("_Not posted._");
    expect(brief).toContain("lines are at `sssssss`");
    expect(brief).toContain(`${"y".repeat(1_200)}…`);
    expect(brief.indexOf("## Previous findings")).toBeLessThan(brief.indexOf("## Open threads"));
  });

  it("has no previous findings section on a first review", () => {
    const brief = buildReviewBrief({
      title: "t",
      body: "",
      pr,
      mergeBaseOid: "m".repeat(40),
      files: [],
      sinceFiles: null,
    });
    expect(brief).not.toContain("## Previous findings");
  });

  it("is written under .yugotool in the worktree", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yugotool-brief-"));
    const file = await writeReviewBrief(dir, "# brief\n");
    expect(file).toBe(path.join(dir, REVIEW_BRIEF_PATH));
    expect(readFileSync(file, "utf8")).toBe("# brief\n");
  });
});
