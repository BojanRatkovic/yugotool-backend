import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Listener {
  pid: number;
  port: string;
  cwd: string | null;
}

/** Parses `lsof -F` output (lines prefixed p<pid>, n<name>) into pid → names. */
export function parseLsof(output: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (!result.has(pid)) result.set(pid, []);
    } else if (line.startsWith("n") && pid !== null) {
      result.get(pid)?.push(line.slice(1));
    }
  }
  return result;
}

/** This user's processes listening on TCP, with their working directory. */
export async function tcpListeners(): Promise<Listener[]> {
  const ports = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).then(
    (r) => parseLsof(r.stdout),
    // lsof exits 1 when nothing matches.
    () => new Map<number, string[]>(),
  );
  if (ports.size === 0) return [];
  const cwds = await exec("lsof", [
    "-a",
    "-p",
    [...ports.keys()].join(","),
    "-d",
    "cwd",
    "-Fpn",
  ]).then(
    (r) => parseLsof(r.stdout),
    () => new Map<number, string[]>(),
  );
  return [...ports].map(([pid, names]) => ({
    pid,
    port: names[0]?.split(":").pop() ?? "?",
    cwd: cwds.get(pid)?.[0] ?? null,
  }));
}

const isInside = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);

/** Listeners that were not there before and run from inside one of `roots`. */
export function strayListeners(
  before: Set<number>,
  after: Listener[],
  roots: string[],
): Listener[] {
  return after.filter(
    (l) =>
      !before.has(l.pid) && l.cwd !== null && roots.some((root) => isInside(l.cwd ?? "", root)),
  );
}

/** The worktree plus the main checkout it belongs to (where agents sometimes wander). */
export async function runRoots(worktreePath: string): Promise<string[]> {
  const { stdout } = await exec("git", [
    "-C",
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return [worktreePath, path.dirname(stdout.trim())];
}
