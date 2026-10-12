import { execFileSync } from "node:child_process";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { GATE_DECISION_SIGNAL, type Station } from "@yugotool/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QaResult, RunContext, ShiftResult } from "../activities";
import { workOrderRun } from "./work-order-run.workflow";

/** The temporal CLI on PATH serves as the test server; otherwise the SDK downloads one. */
function localTemporal(): string | null {
  try {
    return execFileSync("which", ["temporal"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const build: Station = {
  key: "build",
  kind: "agent",
  name: "Build",
  role: "builder",
  model: "m",
  allowedTools: ["Read", "Edit"],
  canEdit: true,
  prompt: "",
};
const qa: Station = {
  key: "qa",
  kind: "qa",
  name: "QA",
  model: "m",
  prompt: "",
  viewports: ["desktop"],
  themes: ["light"],
  alwaysCheck: [],
  diffThresholdPct: 0.01,
  interactive: true,
  planner: true,
};
const reviewGate: Station = { key: "review_gate", kind: "gate", name: "Final review", prompt: "" };

const context: RunContext = {
  stations: [build, qa, reviewGate],
  title: "Add a date",
  description: "",
  modelOverride: null,
  effortOverride: null,
  maxBudgetUsd: null,
  worktreePath: "/wt/repo",
  branch: "yugotool/x",
  baseBranch: "main",
};

function activities(qaResult: QaResult) {
  const calls: string[] = [];
  let gateWaiting: (() => void) | null = null;
  const track = <T>(name: string, value: (input: never) => T | Promise<T>) =>
    vi.fn(async (input: never) => {
      calls.push(name);
      return value(input);
    });
  // The builder works in shifts (spec 0012); one shift finishes the job.
  const shift: ShiftResult = {
    shiftId: "sh",
    sessionId: "s",
    endReason: "done",
    handoff: null,
    output: "built",
    costUsd: 0.1,
    commits: 1,
    tasksDone: 1,
    tasksTotal: 1,
    stopAfter: false,
    contextPct: 10,
  };
  return {
    calls,
    onGate: (fn: () => void) => (gateWaiting = fn),
    mocks: {
      prepareRun: track("prepareRun", () => context),
      beginStation: track("beginStation", (input: { stationKey: string; status: string }) => {
        if (input.status === "awaiting_approval") setTimeout(() => gateWaiting?.(), 10);
        return `sr-${input.stationKey}`;
      }),
      finishStation: track("finishStation", () => undefined),
      prepareShiftStation: track("prepareShiftStation", () => "sha"),
      runShift: track("runShift", () => shift),
      endShifts: track("endShifts", () => undefined),
      foldCheckpoints: track("foldCheckpoints", () => undefined),
      runQaStation: track("runQaStation", () => qaResult),
      repoHooks: track("repoHooks", () => ({ ran: false, passed: true, output: "" })),
      deliver: track("deliver", () => ({ ok: true, error: null })),
      finishRun: track("finishRun", () => undefined),
      archiveRun: track("archiveRun", () => undefined),
      installDependencies: track("installDependencies", () => undefined),
    },
  };
}

const failed = (signedOut: boolean): QaResult => ({
  status: "failed",
  summary: "Every screen was the sign-in page: click Sign in again.",
  report: "QA failed",
  costUsd: 0.2,
  ...(signedOut ? { signedOut } : {}),
});

describe("QA that only saw the sign-in page", () => {
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

  async function run(acts: ReturnType<typeof activities>) {
    const taskQueue = `qa-${crypto.randomUUID()}`;
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
      acts.onGate(() => {
        void handle.signal(GATE_DECISION_SIGNAL, {
          stationKey: "review_gate",
          decision: "approve",
          comment: "",
        });
      });
      await handle.result().catch(() => undefined);
    });
  }

  it("does not send the work back to the builder; the final gate decides", async () => {
    const acts = activities(failed(true));
    await run(acts);
    expect(acts.mocks.runShift).toHaveBeenCalledTimes(1);
    expect(acts.mocks.runQaStation).toHaveBeenCalledTimes(1);
    expect(acts.calls).toContain("deliver");
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({ status: "succeeded" });
  }, 120_000);

  it("a real QA failure still goes back to the builder", async () => {
    const acts = activities(failed(false));
    await run(acts);
    expect(acts.mocks.runShift.mock.calls.length).toBeGreaterThan(1);
    expect(acts.calls).not.toContain("deliver");
  }, 120_000);
});
