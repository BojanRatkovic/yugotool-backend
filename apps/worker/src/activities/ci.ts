import {
  CI_STATION_KEY,
  type CiCheck,
  type CiState,
  type CiStatus,
  type StationRunStatus,
} from "@zastava/contracts";
import { type Database, stationRuns, workOrders } from "@zastava/db";
import { and, desc, eq } from "drizzle-orm";
import { type PullRequestCi, readPullRequestCi } from "../runner/ci-checks";
import type { CiMode } from "../workflows/ci-logic";
import type { ShiftDeps } from "./shifts";

type CiDeps = Pick<ShiftDeps, "appendEvent" | "invalidateBoard" | "notifyHumans">;

/** no_ci / timed_out are not verdicts on the work: the card shows them muted. */
const STATION_STATUS: Record<CiState, StationRunStatus> = {
  pending: "running",
  passed: "succeeded",
  failed: "failed",
  no_ci: "cancelled",
  timed_out: "cancelled",
};

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "?");

export function createCiActivities(db: Database, deps: CiDeps) {
  /** The CI station row of the work order's latest run, created when missing. */
  async function ciStationRun(runId: string, fresh: boolean): Promise<string> {
    if (!fresh) {
      const [existing] = await db
        .select({ id: stationRuns.id })
        .from(stationRuns)
        .where(and(eq(stationRuns.runId, runId), eq(stationRuns.stationKey, CI_STATION_KEY)))
        .orderBy(desc(stationRuns.startedAt))
        .limit(1);
      if (existing) return existing.id;
    }
    const [row] = await db
      .insert(stationRuns)
      .values({ runId, stationKey: CI_STATION_KEY, status: "running" })
      .returning({ id: stationRuns.id });
    if (!row) throw new Error("station run insert returned nothing");
    return row.id;
  }

  return {
    /** The PR's CI right now; null when the work order has no PR. Retried: gh can blip. */
    async pollCi(input: { workOrderId: string }): Promise<PullRequestCi | null> {
      const [row] = await db
        .select({ prUrl: workOrders.prUrl })
        .from(workOrders)
        .where(eq(workOrders.id, input.workOrderId));
      if (!row?.prUrl) return null;
      return readPullRequestCi(row.prUrl);
    },

    /**
     * Stores a poll on the work order (`ci`) and the CI station row. A final
     * result is logged to Activity (and a failure notifies) only when it
     * differs from what was there, so refreshes on panel open stay quiet.
     */
    async recordCi(input: {
      workOrderId: string;
      mode: CiMode;
      /** First poll of this watch. */
      first: boolean;
      state: CiState;
      summary: string;
      poll: PullRequestCi;
    }): Promise<void> {
      const [workOrder] = await db
        .select({ ci: workOrders.ci, runId: workOrders.currentRunId })
        .from(workOrders)
        .where(eq(workOrders.id, input.workOrderId));
      if (!workOrder) return;
      const previous = workOrder.ci;
      const now = new Date().toISOString();
      const delivered = input.mode === "delivery" && input.first;
      const final = input.state !== "pending";
      const ci: CiStatus = {
        state: input.state,
        summary: input.summary,
        prState: input.poll.prState,
        headSha: input.poll.headSha,
        deliveredSha: delivered ? input.poll.headSha : (previous?.deliveredSha ?? null),
        checks: input.poll.checks,
        startedAt: input.first || !previous ? now : previous.startedAt,
        checkedAt: now,
        finishedAt: final ? now : null,
      };
      await db.update(workOrders).set({ ci }).where(eq(workOrders.id, input.workOrderId));

      const changed =
        !previous ||
        delivered ||
        previous.state !== ci.state ||
        previous.headSha !== ci.headSha ||
        previous.summary !== ci.summary;
      if (workOrder.runId && (changed || !final)) {
        const stationRunId = await ciStationRun(workOrder.runId, delivered);
        await db
          .update(stationRuns)
          .set({
            status: STATION_STATUS[ci.state],
            output: ci.summary,
            finishedAt: final ? new Date(now) : null,
            ...(input.first ? { startedAt: new Date(now) } : {}),
          })
          .where(eq(stationRuns.id, stationRunId));
        if (final && changed) await logResult(workOrder.runId, stationRunId, ci);
      }
      await deps.invalidateBoard();
      if (final && changed && ci.state === "failed") {
        await deps.notifyHumans(input.workOrderId, (title) => ({
          title: `CI failed: ${title}`,
          body: `${ci.summary}. ${failing(ci.checks)[0]?.link ?? ""}`.trim(),
        }));
      }
    },
  };

  async function logResult(runId: string, stationRunId: string, ci: CiStatus): Promise<void> {
    const head = `on ${shortSha(ci.headSha)}${
      ci.deliveredSha && ci.headSha !== ci.deliveredSha ? " (newer than ZASTAVA's push)" : ""
    }`;
    const type = ci.state === "failed" ? "error" : "system";
    await deps.appendEvent(
      runId,
      stationRunId,
      type,
      `CI ${LABEL[ci.state]} ${head}: ${ci.summary}`,
    );
    for (const check of failing(ci.checks)) {
      await deps.appendEvent(
        runId,
        stationRunId,
        "error",
        `✗ ${checkName(check)}${check.link ? ` — ${check.link}` : ""}`,
      );
    }
  }
}

const failing = (checks: CiCheck[]): CiCheck[] =>
  checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");

const checkName = (check: CiCheck): string =>
  check.workflow ? `${check.workflow} / ${check.name}` : check.name;

const LABEL: Record<CiState, string> = {
  pending: "running",
  passed: "passed",
  failed: "failed",
  no_ci: "not reported",
  timed_out: "timed out",
};
