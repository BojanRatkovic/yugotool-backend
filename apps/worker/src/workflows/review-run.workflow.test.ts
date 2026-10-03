import { execFileSync } from "node:child_process";
import path from "node:path";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  REVIEW_LINE_STATIONS,
  type ReviewFinding,
  type ReviewVerdict,
  type Station,
} from "@zastava/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStationResult, ReviewRunContext } from "../activities";
import { reviewRun } from "./review-run.workflow";

/** The temporal CLI on PATH serves as the test server; otherwise the SDK downloads one. */
function localTemporal(): string | null {
  try {
    return execFileSync("which", ["temporal"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const review: ReviewVerdict = {
  recommendation: "approve",
  summary: "Fine.",
  findings: [],
  previous: [],
};
const lint: Station = { key: "lint", kind: "checks", name: "Lint", command: "pnpm lint" };

function context(stations: Station[]): ReviewRunContext {
  return {
    stations,
    worktreePath: "/tmp/wt",
    title: "Review #7: Add paging",
    description: "",
    pullRequest: { number: 7, url: "https://x/pull/7" },
    baseBranch: "main",
    modelOverride: null,
    effortOverride: null,
    maxBudgetUsd: null,
  };
}

function activities(opts: {
  stations: Station[];
  checksPass?: boolean;
  agent?: () => Promise<AgentStationResult>;
}) {
  const calls: string[] = [];
  const completed: { stationRunId: string; extra: ReviewFinding[] }[] = [];
  const track = <T>(name: string, value: (input: never) => T | Promise<T>) =>
    vi.fn(async (input: never) => {
      calls.push(name);
      return value(input);
    });
  return {
    calls,
    completed,
    mocks: {
      prepareReview: track("prepareReview", () => context(opts.stations)),
      prepareKnowledge: track("prepareKnowledge", () => []),
      beginStation: track(
        "beginStation",
        (input: { stationKey: string }) => `sr-${input.stationKey}`,
      ),
      finishStation: track("finishStation", () => undefined),
      runChecks: track("runChecks", () => ({
        passed: opts.checksPass ?? true,
        output: "lint error",
      })),
      runAgentStation: track(
        "runAgentStation",
        opts.agent ??
          (() => ({
            sessionId: "s",
            output: "ok",
            isError: false,
            costUsd: 0.5,
            verdict: null,
            review,
          })),
      ),
      completeReview: vi.fn(async (input: { stationRunId: string; extra: ReviewFinding[] }) => {
        calls.push("completeReview");
        completed.push(input);
        return review;
      }),
      finishRun: track("finishRun", () => undefined),
      removeReviewWorkspace: track("removeReviewWorkspace", () => undefined),
    },
  };
}

describe("reviewRun", () => {
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

  async function run(
    acts: ReturnType<typeof activities>,
    onStarted?: (cancel: () => Promise<void>) => Promise<void>,
  ) {
    const taskQueue = `review-${crypto.randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: path.join(__dirname, "review-run.workflow.ts"),
      activities: acts.mocks,
    });
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(reviewRun, {
        taskQueue,
        workflowId: `run-${crypto.randomUUID()}`,
        args: [{ runId: "r1", workOrderId: "w1" }],
      });
      if (onStarted) await onStarted(() => handle.cancel().then(() => undefined));
      await handle.result().catch(() => undefined);
    });
  }

  it("runs the line in order and turns a failing check into a finding", async () => {
    const acts = activities({ stations: [lint, ...REVIEW_LINE_STATIONS], checksPass: false });
    await run(acts);
    expect(acts.calls).toEqual([
      "prepareReview",
      "prepareKnowledge",
      "beginStation",
      "runChecks",
      "finishStation",
      "beginStation",
      "runAgentStation",
      "finishStation",
      "completeReview",
      "finishRun",
      "removeReviewWorkspace",
    ]);
    const [completed] = acts.completed;
    expect(completed?.stationRunId).toBe("sr-review");
    expect(completed?.extra).toHaveLength(1);
    expect(completed?.extra[0]?.title).toContain("pnpm lint");
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({ status: "succeeded" });
  }, 120_000);

  it("fails without completing when the reviewer returns no review", async () => {
    const acts = activities({
      stations: REVIEW_LINE_STATIONS,
      agent: async () => ({
        sessionId: "s",
        output: "prose",
        isError: false,
        costUsd: 0.1,
        verdict: null,
        review: null,
      }),
    });
    await run(acts);
    expect(acts.mocks.completeReview).not.toHaveBeenCalled();
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      reason: "Review returned no structured review",
    });
    expect(acts.mocks.removeReviewWorkspace).toHaveBeenCalled();
  }, 120_000);

  it("cleans up the worktree when cancelled mid-review", async () => {
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => (started = resolve));
    const acts = activities({
      stations: REVIEW_LINE_STATIONS,
      agent: async () => {
        started();
        const ctx = Context.current();
        for (;;) {
          ctx.heartbeat();
          await ctx.sleep(50);
        }
      },
    });
    await run(acts, async (cancel) => {
      await agentStarted;
      await cancel();
    });
    expect(acts.mocks.completeReview).not.toHaveBeenCalled();
    expect(acts.mocks.finishRun.mock.calls[0]?.[0]).toMatchObject({ status: "cancelled" });
    expect(acts.mocks.removeReviewWorkspace).toHaveBeenCalled();
  }, 120_000);
});
