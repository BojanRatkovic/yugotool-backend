import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PackageJson, RepoFacts } from "./preview-detect";

const exec = promisify(execFile);

/**
 * The root files detection needs, read at `ref` (what worktrees start from);
 * falls back to the working tree when the ref has no commits yet.
 */
export async function readRepoFacts(repo: string, ref: string): Promise<RepoFacts> {
  const tree = await exec("git", ["-C", repo, "ls-tree", "--name-only", ref]).then(
    ({ stdout }) => stdout.split("\n").filter(Boolean),
    () => null,
  );
  const files = tree ?? (await readdir(repo).catch(() => []));
  const read = (file: string): Promise<string | null> =>
    !files.includes(file)
      ? Promise.resolve(null)
      : tree
        ? exec("git", ["-C", repo, "show", `${ref}:${file}`], { maxBuffer: 4 * 1024 * 1024 }).then(
            ({ stdout }) => stdout,
            () => null,
          )
        : readFile(path.join(repo, file), "utf8").catch(() => null);
  const [pkg, nvmrc, nodeVersionFile] = await Promise.all([
    read("package.json"),
    read(".nvmrc"),
    read(".node-version"),
  ]);
  return { files, packageJson: parsePackageJson(pkg), nvmrc, nodeVersionFile };
}

function parsePackageJson(raw: string | null): PackageJson | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
