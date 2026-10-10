import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESEARCH_PLAN_JSON_SCHEMA, stationResearchSchema } from "@zastava/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  describeSync,
  fallbackPlan,
  firstMentioned,
  hubResearchPrompt,
  researchOutput,
  resolveResearch,
  syncDecision,
  syncHubRepos,
} from "./hub-research";
import { pathViolation } from "./tool-confinement";

const root = mkdtempSync(path.join(os.tmpdir(), "zastava-hub-research-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

describe("syncDecision", () => {
  const clean = { branch: "develop", baseBranch: "develop", dirty: false, hasRemoteBase: true };
  it("fast-forwards only a clean checkout on its base branch", () => {
    expect(syncDecision(clean)).toEqual({ ff: true });
    expect(syncDecision({ ...clean, dirty: true })).toEqual({
      ff: false,
      reason: "uncommitted changes",
    });
    expect(syncDecision({ ...clean, branch: "feature/x" })).toEqual({
      ff: false,
      reason: "on feature/x",
    });
    expect(syncDecision({ ...clean, branch: "" })).toEqual({ ff: false, reason: "detached HEAD" });
    expect(syncDecision({ ...clean, hasRemoteBase: false })).toEqual({
      ff: false,
      reason: "no origin/develop",
    });
  });
});

describe("syncHubRepos", () => {
  it("updates clean base checkouts and leaves dirty or switched ones alone", async () => {
    const hub = path.join(root, "hub");
    const upstream = path.join(root, "upstream");
    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(path.join(upstream, "a.txt"), "1\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "one");
    for (const name of ["api", "web", "docs"]) {
      git(root, "clone", "-q", upstream, path.join(hub, "repos", name));
    }
    writeFileSync(path.join(upstream, "a.txt"), "2\n");
    git(upstream, "commit", "-q", "-am", "two");
    const head = git(upstream, "rev-parse", "--short", "HEAD");
    writeFileSync(path.join(hub, "repos", "web", "a.txt"), "local edit\n");
    git(path.join(hub, "repos", "docs"), "checkout", "-q", "-b", "feature");

    const results = await syncHubRepos(hub, [
      { name: "api", baseBranch: "main" },
      { name: "web", baseBranch: "main" },
      { name: "docs", baseBranch: "main" },
    ]);
    expect(results.find((r) => r.name === "api")).toMatchObject({ skipped: false });
    expect(results.find((r) => r.name === "api")?.outcome).toMatch(new RegExp(`\\.\\.${head}$`));
    expect(git(path.join(hub, "repos", "api"), "rev-parse", "--short", "HEAD")).toBe(head);
    expect(results.find((r) => r.name === "web")).toMatchObject({
      skipped: true,
      outcome: "uncommitted changes",
    });
    expect(git(path.join(hub, "repos", "web"), "diff", "--name-only")).toBe("a.txt");
    expect(results.find((r) => r.name === "docs")).toMatchObject({
      skipped: true,
      outcome: "on feature",
    });

    const again = await syncHubRepos(hub, [{ name: "api", baseBranch: "main" }]);
    expect(again[0]?.outcome).toBe("up to date");
    expect(describeSync(results)).toMatch(
      /^Hub repos synced · api updated .* · skipped web \(uncommitted changes\), docs \(on feature\)$/,
    );
  });
});

describe("hubResearchPrompt", () => {
  const base = { hub: "/w/hub", repos: ["api", "web"], presetRepo: null };
  it("lists the repos and asks the planning station for repo and split", () => {
    const prompt = hubResearchPrompt({ ...base, plans: true });
    expect(prompt).toContain("`repos/api`, `repos/web`");
    expect(prompt).toContain("set `repo` to its name");
    expect(prompt).toContain("propose a `split`");
    expect(prompt).toContain("Do not modify anything");
  });
  it("tells it a preset repo", () => {
    expect(hubResearchPrompt({ ...base, presetRepo: "web", plans: true })).toContain(
      "This work order is set to `web`",
    );
  });
  it("other read-only stations get the hub, not the plan instructions", () => {
    const prompt = hubResearchPrompt({ ...base, plans: false });
    expect(prompt).toContain("`repos/api`");
    expect(prompt).not.toContain("split");
  });
});

describe("resolveResearch", () => {
  const repos = ["shop-backend", "shop-frontend", "shop"];

  it("keeps a known repo, matching case-insensitively and without repos/", () => {
    expect(resolveResearch({ plan: "p", repo: "shop-backend" }, repos, null).repo).toBe(
      "shop-backend",
    );
    expect(resolveResearch({ plan: "p", repo: "repos/Shop-Frontend/" }, repos, null).repo).toBe(
      "shop-frontend",
    );
  });

  it("falls back to the first repo the plan mentions, else null", () => {
    const plan = "1. Change `repos/shop-frontend/src/a.tsx`\n2. Then shop-backend";
    expect(resolveResearch({ plan, repo: "frontend" }, repos, null).repo).toBe("shop-frontend");
    expect(resolveResearch({ plan: "no repo named", repo: "x" }, repos, null).repo).toBeNull();
  });

  it("a preset repo wins over the model's pick", () => {
    expect(resolveResearch({ plan: "p", repo: "shop-backend" }, repos, "shop").repo).toBe(
      "shop",
    );
  });

  it("keeps a resolvable split and takes its first repo; drops a bad or single-item one", () => {
    const split = [
      { title: "API", description: "add endpoint", repo: "shop-backend" },
      { title: "UI", description: "use it in shop-frontend", repo: "frontend-app" },
    ];
    const resolved = resolveResearch({ plan: "p", repo: "shop-frontend", split }, repos, null);
    expect(resolved.repo).toBe("shop-backend");
    expect(resolved.split?.map((s) => s.repo)).toEqual(["shop-backend", "shop-frontend"]);
    const bad = [split[0]!, { title: "?", description: "?", repo: "nope" }];
    expect(resolveResearch({ plan: "p", repo: "shop", split: bad }, repos, null)).toEqual({
      plan: "p",
      repo: "shop",
    });
    expect(
      resolveResearch({ plan: "p", repo: "shop", split: [split[0]!] }, repos, null).split,
    ).toBeUndefined();
  });

  it("matches whole names only, longest first", () => {
    expect(firstMentioned("see shop-backend first", repos)).toBe("shop-backend");
    expect(firstMentioned("shop then shop-backend", repos)).toBe("shop");
    expect(firstMentioned("shops", repos)).toBeNull();
  });

  it("stores as a station research and reads as output", () => {
    const research = resolveResearch({ plan: "1. do", repo: "x" }, repos, null);
    expect(stationResearchSchema.parse(research)).toEqual({ plan: "1. do", repo: null });
    expect(researchOutput(research)).toBe("Repo: not chosen — pick one at the plan gate\n\n1. do");
    expect(RESEARCH_PLAN_JSON_SCHEMA).not.toHaveProperty("$schema");
  });
});

describe("read-only confinement", () => {
  it("denies every write in read-only mode, still allows reads in the hub", () => {
    const hub = "/w/hub";
    expect(pathViolation("Edit", { file_path: `${hub}/a.md` }, hub, [], true)).toMatch(/read-only/);
    expect(pathViolation("Write", { file_path: "/tmp/x" }, hub, [], true)).toMatch(/read-only/);
    expect(pathViolation("Read", { file_path: `${hub}/repos/api/a.ts` }, hub, [], true)).toBeNull();
    expect(pathViolation("Edit", { file_path: `${hub}/a.md` }, hub)).toBeNull();
  });
});

describe("fallbackPlan", () => {
  it("takes the session's longest text over a short closing line", () => {
    const plan = "## Summary\n1. Edit repos/web/src/card.tsx to show the due date";
    expect(
      fallbackPlan(["Mapping the code.", plan, "I already sent it."], "I already sent it."),
    ).toBe(plan);
    expect(fallbackPlan([], "1. Do it")).toBe("1. Do it");
  });
});
