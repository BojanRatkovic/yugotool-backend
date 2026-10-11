import { execFileSync } from "node:child_process";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { GATE_DECISION_SIGNAL, type GateDecision, type Station } from "@yugotool/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStationResult, RunContext } from "../activities";
import { workOrderRun } from "./work-order-run.workflow";

/** The temporal CLI on PATH serves as the test server; otherwise the SDK downloads one. */
function localTemporal(): string | null {
  try {
    return execFileSync("which", ["temporal"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const HUB = "/w/hub";
const research: Station = {
  key: "research",
  kind: "agent",
  name: "Research",
  role: "researcher",
  model: "m",
  allowedTools: ["Read"],
  canEdit: false,
  prompt: "",
};
const planGate: Station = { key: "plan_gate", kind: "gate", name: "Approve plan", prompt: "" };
const checks: Station = { key: "checks", kind: "checks", name: "Checks", command: "true" };
const LINE = [research, planGate, checks];

function context(kind: "repo" | "hub" | undefined, repo: string | null = null): RunContext {
  const base = {
    stations: LINE,
    title: "Add paging",
    description: "",
    modelOverride: null,
    effortOverride: null,
    maxBudgetUsd: null,
  };
  return kind === "hub"
    ? {
        ...base,
        worktreePath: HUB,
        branch: "",
        baseBranch: "",
        kind,
        hubPath: HUB,
        repos: ["api", "web"],
        repo,
      }
    : { ...base, worktreePath: "/wt/repo", branch: "yugotool/x", baseBranch: "main" };
}

function activities(ctx: RunContext, researchRepo: string | null) {
  const calls: string[] = [];
  let gateWaiting: (() => void) | null = null;
  const track = <T>(name: string, value: (input: never) => T | Promise<T>) =>
    vi.fn(async (input: never) => {
      calls.push(name);
      return value(input);
    });
  const agentResult = (): AgentStationResult => ({
    sessionId: "s",
    output: "plan",
    isError: false,
    costUsd: 0.1,
    verdict: null,
    review: null,
    research: ctx.kind === "hub" ? { plan: "plan", repo: researchRepo } : null,
  });
  return {
    calls,
    onGate: (fn: () => void) => (gateWaiting = fn),
    mocks: {
      prepareRun: track("prepareRun", () => ctx),
      beginStation: track("beginStation", (input: { stationKey: string; status: string }) => {
        if (input.status === "awaiting_approval") setTimeout(() => gateWaiting?.(), 10);
        return `sr-${input.stationKey}`;
      }),
      finishStation: track("finishStation", () => undefined),
      runAgentStation: track("runAgentStation", agentResult),
      prepareRepoWorkspace: track("prepareRepoWorkspace", (input: { repo: string }) => ({
        worktreePath: `${HUB}/worktrees/${input.repo}-yugotool-x`,
        branch: "yugotool/add-paging",
        baseBranch: "develop",
      })),
      runChecks: track("runChecks", () => ({ passed: true, output: "" })),
      repoHooks: track("repoHooks", () => ({ ran: false, passed: true, output: "" })),
      deliver: track("deliver", () => ({ ok: true, error: null })),
      finishRun: track("finishRun", () => undefined),
      archiveRun: track("archiveRun", () => undefined),
      installDependencies: track("installDependencies", () => undefined),
    },
  };
}

describe("workOrderRun in a hub project (spec 0014)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    const cli = localTemporal();
    env = await TestWorkflowEnvironment.createLocal(
      cli ? { server: { executable: { type: "existing-path", path: cli } } } : {},
    );
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function run(acts: ReturnType<typeof activities>, decisions: GateDecision[]) {
    const taskQueue = `hub-${crypto.randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: path.join(__dirname, "work-order-run.workflow.ts"),
      activities: acts.mocks,
    });
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(workOrderRun, {
        taskQueue,
        workflowId: `run-${crypto.randomUUID()}`,
        args: [{ runId: "r1", workOrderId: "w1" }],
      });
      const queue = [...decisions];
      acts.onGate(() => {
        const next = queue.shift();
        if (next) void handle.signal(GATE_DECISION_SIGNAL, { stationKey: "plan_gate", ...next });
      });
      await handle.result().catch(() => undefined);
    });
  }

  const approve: GateDecision = { decision: "approve", comment: "" };

  it("plans in the hub, then makes the chosen repo's worktree after the plan gate", async () => {
    const acts = activities(context("hub"), "api");
    await run(acts, [approve]);
    expect(acts.calls).toEqual([
      "prepareRun",
      "beginStation",
      "runAgentStation",
      "finishStation",
      "beginStation",
      "finishStation",
      "prepareRepoWorkspace",
      "installDependencies",
      "beginStation",
      "runChecks",
      "finishStation",
      "repoHooks",
      "deliver",
      "finishRun",
      "archiveRun",
    ]);
    expect(acts.mocks.runAgentStation.mock.calls[0]?.[0]).toMatchObject({
      worktreePath: HUB,
      hubResearch: { hub: HUB, repos: ["api", "web"], presetRepo: null, plans: true },
    });
    expect(acts.mocks.prepareRepoWorkspace.mock.calls[0]?.[0]).toMatchObject({ repo: "api" });
    expect(acts.mocks.runChecks.mock.calls[0]?.[0]).toMatchObject({
      worktreePath: `${HUB}/worktrees/api-yugotool-x`,
    });
    expect(acts.mocks.deliver.mock.calls[0]?.[0]).toMatchObject({
      worktreePath: `${HUB}/worktrees/api-yugotool-x`,
      branch: "yugotool/add-paging",
      baseBranch: "develop",
    });
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({ status: "succeeded" });
  }, 120_000);

  it("the plan gate can switch the repo", async () => {
    const acts = activities(context("hub"), "api");
    await run(acts, [{ ...approve, repo: "web" }]);
    expect(acts.mocks.prepareRepoWorkspace.mock.calls[0]?.[0]).toMatchObject({ repo: "web" });
  }, 120_000);

  it("changes requested at the plan gate re-run Research in the hub, still without a worktree", async () => {
    const acts = activities(context("hub", "web"), "web");
    await run(acts, [{ decision: "request_changes", comment: "also docs" }, approve]);
    const agents = acts.mocks.runAgentStation.mock.calls.map(
      (c) => (c[0] as { worktreePath: string }).worktreePath,
    );
    expect(agents).toEqual([HUB, HUB]);
    expect(acts.calls.indexOf("prepareRepoWorkspace")).toBeGreaterThan(
      acts.calls.lastIndexOf("runAgentStation"),
    );
    expect(acts.mocks.prepareRepoWorkspace).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("fails before any worktree when no repo was chosen", async () => {
    const acts = activities(context("hub"), null);
    await run(acts, [approve]);
    expect(acts.mocks.prepareRepoWorkspace).not.toHaveBeenCalled();
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      reason: "No repo chosen for this work: Research named none of the hub's repos",
    });
  }, 120_000);

  it("a regular repo run is unchanged", async () => {
    const acts = activities(context(undefined), null);
    await run(acts, [approve]);
    expect(acts.calls).toEqual([
      "prepareRun",
      "installDependencies",
      "beginStation",
      "runAgentStation",
      "finishStation",
      "repoHooks",
      "beginStation",
      "finishStation",
      "beginStation",
      "runChecks",
      "finishStation",
      "deliver",
      "finishRun",
      "archiveRun",
    ]);
    const agent = acts.mocks.runAgentStation.mock.calls[0]?.[0];
    expect(agent).toMatchObject({ worktreePath: "/wt/repo" });
    expect(agent).not.toHaveProperty("hubResearch");
  }, 120_000);
});
