import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `origin/<base>` when the repo has it, else the local base branch (as the worker does). */
export async function baseRef(repo: string, baseBranch: string): Promise<string> {
  const remoteBase = `origin/${baseBranch}`;
  return exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", remoteBase]).then(
    () => remoteBase,
    () => baseBranch,
  );
}
