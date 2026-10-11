import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectRemote } from "@yugotool/contracts";

const exec = promisify(execFile);

/** Whether PR delivery can work, and why not. Pure. */
export function remoteVerdict(input: {
  origin: string | null;
  ghInstalled: boolean;
  ghLoggedIn: boolean;
}): ProjectRemote {
  const github = input.origin !== null && /github\.com[:/]/.test(input.origin);
  const reason =
    input.origin === null
      ? "This repo has no origin remote, so there is nowhere to push."
      : !github
        ? "origin is not on GitHub, so YugoTool can push but not open the pull request."
        : !input.ghInstalled
          ? "The GitHub CLI (gh) isn't installed."
          : !input.ghLoggedIn
            ? "The GitHub CLI isn't logged in (gh auth login)."
            : null;
  return {
    origin: input.origin,
    github,
    ghLoggedIn: input.ghLoggedIn,
    prPossible: reason === null,
    reason,
  };
}

/** Reads origin from the repo and asks gh whether it is logged in. */
export async function projectRemote(repoPath: string): Promise<ProjectRemote> {
  const origin = await exec("git", ["-C", repoPath, "remote", "get-url", "origin"]).then(
    ({ stdout }) => stdout.trim() || null,
    () => null,
  );
  const gh = await exec("gh", ["auth", "status"], { timeout: 5_000 }).then(
    () => ({ installed: true, loggedIn: true }),
    (error: NodeJS.ErrnoException) => ({ installed: error.code !== "ENOENT", loggedIn: false }),
  );
  return remoteVerdict({ origin, ghInstalled: gh.installed, ghLoggedIn: gh.loggedIn });
}
