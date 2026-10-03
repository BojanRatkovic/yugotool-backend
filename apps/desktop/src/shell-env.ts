import { spawnSync } from "node:child_process";

const MARK = "__ZASTAVA_PATH__";

/** Pulls the PATH out of the shell's output, ignoring anything rc files print. Pure. */
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(MARK);
  const end = output.indexOf(MARK, start + MARK.length);
  if (start === -1 || end === -1) return null;
  const value = output.slice(start + MARK.length, end).trim();
  return value || null;
}

/**
 * Apps opened from Finder get launchd's PATH (/usr/bin:/bin:…), without
 * Homebrew, nvm or the user's tools. The login shell knows the real one; git,
 * gh, nvm, temporal and the agents' Bash all depend on it.
 */
export function loginShellPath(shell = process.env["SHELL"] ?? "/bin/zsh"): string | null {
  const result = spawnSync(shell, ["-ilc", `printf '%s' "${MARK}$PATH${MARK}"`], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, TERM: "dumb" },
  });
  return result.status === 0 ? parseShellPath(result.stdout) : null;
}
