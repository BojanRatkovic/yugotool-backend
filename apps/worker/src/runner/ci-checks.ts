import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type CiCheck, ciBucketSchema } from "@yugotool/contracts";
import { z } from "zod";

const exec = promisify(execFile);

const CHECK_FIELDS = "name,state,bucket,link,workflow,startedAt,completedAt";

const ghCheckSchema = z.object({
  name: z.string(),
  // gh may add buckets; an unknown one is treated as still running.
  bucket: ciBucketSchema.catch("pending"),
  link: z.string().default(""),
  workflow: z.string().default(""),
  startedAt: z.string().default(""),
  completedAt: z.string().default(""),
});

/** Commit statuses carry no times; gh reports them as year 1. */
const toDate = (value: string): string | null =>
  value === "" || value.startsWith("0001-") ? null : new Date(value).toISOString();

/** `gh pr checks --json …` output → checks. Pure. */
export function parseChecks(stdout: string): CiCheck[] {
  return z
    .array(ghCheckSchema)
    .parse(JSON.parse(stdout))
    .map((c) => ({
      name: c.name,
      workflow: c.workflow || null,
      bucket: c.bucket,
      link: c.link || null,
      startedAt: toDate(c.startedAt),
      completedAt: toDate(c.completedAt),
    }));
}

/** gh's way of saying the PR has no checks (exit 1, nothing on stdout). */
export function isNoChecksError(error: unknown): boolean {
  const stderr =
    error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  return /no checks reported/i.test(stderr);
}

const prViewSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: z.string(),
});

const PR_STATE = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const;

export interface PullRequestCi {
  prState: "open" | "closed" | "merged";
  headSha: string;
  checks: CiCheck[];
}

/**
 * The PR's state, head and checks (GitHub Actions check runs and commit
 * statuses such as Semaphore, merged by gh). Needs only the PR url.
 */
export async function readPullRequestCi(prUrl: string): Promise<PullRequestCi> {
  const { stdout: view } = await exec("gh", ["pr", "view", prUrl, "--json", "state,headRefOid"]);
  const pr = prViewSchema.parse(JSON.parse(view));
  let checks: CiCheck[];
  try {
    const { stdout } = await exec("gh", ["pr", "checks", prUrl, "--json", CHECK_FIELDS]);
    checks = parseChecks(stdout);
  } catch (error) {
    // Exit 1 = a check failed, 8 = pending; with --json the output is still complete.
    const stdout =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    if (stdout.trim().startsWith("[")) checks = parseChecks(stdout);
    else if (isNoChecksError(error)) checks = [];
    else throw error;
  }
  return {
    prState: PR_STATE[pr.state],
    headSha: pr.headRefOid,
    checks,
  };
}
