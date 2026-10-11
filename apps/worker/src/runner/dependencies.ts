// Installing a fresh worktree's dependencies (gems, node_modules), as a person
// does after `git worktree add`: without them no test, lint or repo hook can
// run, and the builder can only say it couldn't check anything.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface InstallStep {
  /** What Activity shows: "pnpm install". */
  label: string;
  command: string;
}

/**
 * The install commands a checkout's root lockfiles call for, frozen to the
 * lockfile (an install must not rewrite it: that would show up in the diff).
 * Pure over the file names present and package.json's packageManager.
 */
export function installSteps(
  files: ReadonlySet<string>,
  packageManager: string | null,
): InstallStep[] {
  const steps: InstallStep[] = [];
  if (files.has("Gemfile.lock")) steps.push({ label: "bundle install", command: "bundle install" });
  const pm = packageManager?.split("@")[0] ?? null;
  if (files.has("pnpm-lock.yaml") || pm === "pnpm") {
    steps.push({
      label: "pnpm install",
      command: "pnpm install --frozen-lockfile --prefer-offline",
    });
  } else if (files.has("bun.lock") || files.has("bun.lockb")) {
    steps.push({ label: "bun install", command: "bun install --frozen-lockfile" });
  } else if (files.has("yarn.lock")) {
    steps.push({
      label: "yarn install",
      // Yarn 2+ (a .yarnrc.yml) dropped --frozen-lockfile for --immutable.
      command: files.has(".yarnrc.yml")
        ? "corepack yarn install --immutable"
        : "corepack yarn install --frozen-lockfile",
    });
  } else if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) {
    steps.push({ label: "npm ci", command: "npm ci --prefer-offline --no-audit --no-fund" });
  }
  return steps;
}

const LOCKFILES = [
  "Gemfile.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  ".yarnrc.yml",
  "package-lock.json",
  "npm-shrinkwrap.json",
];

/** `installSteps` for the checkout at `dir`. */
export function installStepsFor(dir: string): InstallStep[] {
  const files = new Set(LOCKFILES.filter((f) => existsSync(path.join(dir, f))));
  let packageManager: string | null = null;
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const value =
      typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "packageManager") : null;
    packageManager = typeof value === "string" ? value : null;
  } catch {
    // No package.json: only non-JS lockfiles count.
  }
  return installSteps(files, packageManager);
}
