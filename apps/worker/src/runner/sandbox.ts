import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { pinnedNodeEnv } from "./node-versions";
import { deliveryViolation, pathViolation } from "./tool-confinement";

const exec = promisify(execFile);

/** Package registries an agent may reach to install or run project tooling. */
const ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "*.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
];

/**
 * OS-level sandbox for every agent session: Bash may write only inside the
 * run's worktree (plus the repo's git dir, which a worktree's `.git` points
 * to, and the temp dir) and reach only package registries (an agent facing an
 * impossible goal once installed a crontab). The sandbox does not cover file
 * tools, and `allowedTools: ["Edit"]` allows edits anywhere, so a PreToolUse
 * hook keeps Read/Edit/Write/Grep/Glob inside the worktree (plus `readRoots`
 * for reads); a builder once edited the project's main checkout.
 * Fails closed: if the sandbox cannot start, the session errors instead of
 * running unsandboxed.
 */
export async function sandboxFor(
  worktreePath: string,
  /** `readOnly`: nothing but the temp dir is writable (Research in a hub, spec 0014). */
  options: { readRoots?: string[]; readOnly?: boolean } = {},
): Promise<Pick<Options, "sandbox" | "env" | "hooks">> {
  const writable = options.readOnly
    ? [os.tmpdir()]
    : [
        worktreePath,
        (
          await exec("git", [
            "-C",
            worktreePath,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
        ).stdout.trim(),
        os.tmpdir(),
      ];
  const sandbox: NonNullable<Options["sandbox"]> = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: writable },
    network: { allowedDomains: ALLOWED_DOMAINS, allowLocalBinding: true },
  };
  // Package-manager caches default to the home dir, which the sandbox cannot write.
  const cache = path.join(os.tmpdir(), "zastava-pkg-cache");
  // The sandbox covers Bash only; file tools are confined by this hook.
  const confine: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const reason =
      deliveryViolation(input.tool_name, input.tool_input) ??
      pathViolation(
        input.tool_name,
        input.tool_input,
        worktreePath,
        options.readRoots,
        options.readOnly,
      );
    return reason
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }
      : {};
  };
  // The agent's `npm test` runs under the Node the repo pins (spec 0013).
  const env = await pinnedNodeEnv(worktreePath, process.env);
  return {
    sandbox,
    hooks: { PreToolUse: [{ hooks: [confine] }] },
    env: {
      ...env,
      npm_config_cache: path.join(cache, "npm"),
      YARN_CACHE_FOLDER: path.join(cache, "yarn"),
      PNPM_STORE_DIR: path.join(cache, "pnpm"),
    },
  };
}
