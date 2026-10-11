import os from "node:os";
import path from "node:path";

/**
 * YugoTool's data folder: `YUGOTOOL_HOME` (the supervisor always passes it),
 * else `~/.yugotool`. Artifacts, worktrees, knowledge, runtimes and account
 * logins live under it, so a second instance with its own home shares nothing.
 */
export function yugotoolHome(
  userHome: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env["YUGOTOOL_HOME"]
    ? path.resolve(env["YUGOTOOL_HOME"])
    : path.join(userHome, ".yugotool");
}
