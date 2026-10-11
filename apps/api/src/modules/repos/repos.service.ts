import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Repo } from "@yugotool/contracts";
import type { Env } from "../../core/config/env.schema";
import { RepoPathInvalidError } from "../projects/project.errors";
import { hubRepos, isHubRoot } from "../projects/work-hub";
import { SettingsService } from "../settings/settings.service";

const exec = promisify(execFile);
/** Deep enough for `org/client/repo` layouts, shallow enough to stay instant. */
const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", "dist", "build", "vendor", "tmp", "coverage"]);

@Injectable()
export class ReposService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly settings: SettingsService,
  ) {}

  /** Used when Settings → Repos folder is empty. */
  get defaultRoot(): string {
    return this.config.get("REPOS_ROOT", { infer: true });
  }

  /** Settings → Repos folder, else the env default. */
  async root(): Promise<string> {
    return (await this.settings.get()).reposRoot ?? this.defaultRoot;
  }

  async list(): Promise<Repo[]> {
    const repos: Repo[] = [];
    await this.scan(await this.root(), 0, repos);
    return repos.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async branches(repoPath: string): Promise<string[]> {
    if (!(await isGitRepo(repoPath)))
      throw new RepoPathInvalidError(`${repoPath} is not a Git repository`);
    const { stdout } = await exec("git", ["-C", repoPath, "branch", "--format=%(refname:short)"]);
    return stdout.split("\n").filter(Boolean);
  }

  private async scan(dir: string, depth: number, out: Repo[]): Promise<void> {
    // A work hub is listed itself (a hub project, spec 0014) and with its
    // repos (`work/frontend`, each a project on its own, spec 0012).
    if (isHubRoot(dir)) {
      const hubName = path.basename(dir);
      const repos = hubRepos(dir);
      out.push({
        name: hubName,
        path: dir,
        currentBranch: await currentBranch(dir),
        hubPath: dir,
        kind: "hub",
        repoCount: repos.length,
      });
      for (const repo of repos) {
        out.push({
          name: `${hubName}/${repo.name}`,
          path: repo.path,
          currentBranch: await currentBranch(repo.path),
          hubPath: dir,
          kind: "repo",
          repoCount: null,
        });
      }
      return;
    }
    if (await isGitRepo(dir)) {
      out.push({
        name: path.basename(dir),
        path: dir,
        currentBranch: await currentBranch(dir),
        hubPath: null,
        kind: "repo",
        repoCount: null,
      });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
        .map((e) => this.scan(path.join(dir, e.name), depth + 1, out)),
    );
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  return stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );
}

/** Reads HEAD directly: spawning git per repo makes a 100-repo scan slow. */
async function currentBranch(dir: string): Promise<string | null> {
  const head = await readFile(path.join(dir, ".git", "HEAD"), "utf8").catch(() => null);
  const match = head?.match(/^ref: refs\/heads\/(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
