import { spawn } from "node:child_process";

export interface CappedOutput {
  text: string;
  truncated: boolean;
}

/**
 * Runs `git <args>` and keeps at most `maxChars` of stdout. Once the cap is hit
 * the process is killed, so output size never fails the call (unlike execFile's
 * maxBuffer) and a huge diff costs only what we keep.
 */
export function gitCapped(cwd: string, args: string[], maxChars: number): Promise<CappedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let truncated = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      text += chunk;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, ""); // no split surrogate pair
        truncated = true;
        child.stdout.destroy();
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 10_000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (truncated || code === 0) resolve({ text, truncated });
      else reject(new Error(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

export interface DiffLimits {
  patchChars: number;
  statChars: number;
}

/**
 * Worktree vs `base`: committed and uncommitted changes, new files included.
 * Both the patch and the stat are capped; an over-long stat is cut at a line
 * boundary and closed with the `--shortstat` summary so totals stay visible.
 */
export async function worktreeDiff(
  cwd: string,
  base: string,
  limits: DiffLimits,
): Promise<{ stat: string; patch: string; truncated: boolean }> {
  await gitCapped(cwd, ["add", "--intent-to-add", "."], 10_000);
  const [stat, patch] = await Promise.all([
    gitCapped(cwd, ["diff", "--stat", base], limits.statChars),
    gitCapped(cwd, ["diff", base], limits.patchChars),
  ]);
  let statText = stat.text.trim();
  if (stat.truncated) {
    const short = await gitCapped(cwd, ["diff", "--shortstat", base], 1_000);
    const lastNewline = stat.text.lastIndexOf("\n");
    statText = `${stat.text.slice(0, Math.max(lastNewline, 0))}\n …\n${short.text.trim()}`.trim();
  }
  return { stat: statText, patch: patch.text, truncated: patch.truncated };
}
