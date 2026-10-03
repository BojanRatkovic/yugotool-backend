// Pure: which file paths a tool call touches, and whether they stay inside the allowed roots.
import path from "node:path";

/** Tools whose input names a file or directory, and the field that holds it. */
const PATH_FIELDS: Record<string, { field: string; write: boolean }> = {
  Read: { field: "file_path", write: false },
  Edit: { field: "file_path", write: true },
  MultiEdit: { field: "file_path", write: true },
  Write: { field: "file_path", write: true },
  NotebookEdit: { field: "notebook_path", write: true },
  Grep: { field: "path", write: false },
  Glob: { field: "path", write: false },
};

const isInside = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);

/**
 * Null when the call is fine; otherwise why it is refused. Writes must stay in
 * the worktree; reads may also use `readRoots` (e.g. QA screenshots). Relative
 * paths resolve against the worktree. `allowedTools: ["Edit"]` alone would let
 * an agent edit any file on the machine (it once edited the main checkout).
 */
export function pathViolation(
  tool: string,
  input: unknown,
  worktree: string,
  readRoots: string[] = [],
): string | null {
  const spec = PATH_FIELDS[tool];
  if (!spec || typeof input !== "object" || input === null) return null;
  const raw: unknown = Reflect.get(input, spec.field);
  if (typeof raw !== "string" || raw === "") return null;
  const target = path.resolve(worktree, raw);
  const roots = spec.write ? [worktree] : [worktree, ...readRoots];
  if (roots.some((root) => isInside(target, path.resolve(root)))) return null;
  return `${tool} is limited to the run's worktree (${worktree}); ${target} is outside it. Use paths inside the worktree.`;
}
