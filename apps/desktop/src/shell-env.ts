import { spawnSync } from "node:child_process";

const MARK = "__ZASTAVA_PATH__";
const SHELL_TIMEOUT_MS = 10_000;
/** Where Homebrew (Apple silicon, then Intel) puts gh, git, node… */
const WELL_KNOWN_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

export type ShellPath = { path: string; error: null } | { path: null; error: string };

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
export function loginShellPath(shell = process.env["SHELL"] ?? "/bin/zsh"): ShellPath {
  // PATH as printf's argument: in "…$PATH__ZASTAVA_PATH__" the shell would read one longer variable name.
  const result = spawnSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
    encoding: "utf8",
    timeout: SHELL_TIMEOUT_MS,
    // No stdin: an rc file that prompts would otherwise wait for the timeout.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb" },
  });
  // A failing rc line makes zsh exit non-zero after it printed PATH; the marker is what counts.
  const parsed = parseShellPath(result.stdout ?? "");
  if (parsed) return { path: parsed, error: null };
  const why = result.error
    ? result.error.message
    : result.signal
      ? `killed by ${result.signal}`
      : `exit ${result.status}`;
  const stderr = (result.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
  return { path: null, error: `${shell} -ilc: ${why}${stderr ? ` (${stderr})` : ""}` };
}

/** Puts Homebrew's dirs in front when the PATH lacks them, so a failed shell read still finds gh. Pure. */
export function withWellKnownDirs(current: string): string {
  const dirs = current.split(":").filter(Boolean);
  const missing = WELL_KNOWN_DIRS.filter((dir) => !dirs.includes(dir));
  return [...missing, ...dirs].join(":");
}
