import { MODELS } from "@yugotool/contracts";
import {
  type Database,
  lines,
  qaChecks,
  qaRuns,
  shifts,
  stationRuns,
  workOrders,
} from "@yugotool/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { localRunner } from "../runner/local-runner";
import { type PrQa, type PrStation, renderPrBody } from "../runner/pr-body";

export function createPrBodyComposer(db: Database) {
  /** Builds the PR description from what the run recorded, not from free-form notes. */
  return async function composePrBody(input: {
    runId: string;
    workOrderId: string;
    worktreePath: string;
    baseBranch: string;
  }): Promise<string> {
    const [row] = await db
      .select({ description: workOrders.description, line: lines.stations })
      .from(workOrders)
      .innerJoin(lines, and(eq(lines.projectId, workOrders.projectId), eq(lines.kind, "build")))
      .where(eq(workOrders.id, input.workOrderId));
    const line = row?.line ?? [];
    const runRows = await db
      .select()
      .from(stationRuns)
      .where(eq(stationRuns.runId, input.runId))
      .orderBy(asc(stationRuns.startedAt));
    const shiftCounts = await db
      .select({ stationRunId: shifts.stationRunId, count: sql<number>`count(*)::int` })
      .from(shifts)
      .innerJoin(stationRuns, eq(stationRuns.id, shifts.stationRunId))
      .where(eq(stationRuns.runId, input.runId))
      .groupBy(shifts.stationRunId);
    const shiftsByRun = new Map(shiftCounts.map((r) => [r.stationRunId, r.count]));

    const stations: PrStation[] = line.map((station) => {
      const attempts = runRows.filter((r) => r.stationKey === station.key);
      const last = attempts.at(-1);
      return {
        name: station.name,
        kind: station.kind,
        status: last
          ? last.status === "succeeded"
            ? "passed"
            : last.status.replace("_", " ")
          : "skipped",
        attempts: attempts.length,
        model: last?.model ? (MODELS.find((m) => m.id === last.model)?.label ?? last.model) : null,
        costUsd: attempts.reduce((sum, r) => sum + r.costUsd, 0),
        // Builders work in shifts too (spec 0012).
        shifts:
          station.kind === "shift" || (station.kind === "agent" && station.canEdit)
            ? attempts.reduce((sum, r) => sum + (shiftsByRun.get(r.id) ?? 0), 0)
            : null,
      };
    });
    const builderKeys = new Set(
      line.filter((s) => s.kind === "shift" || (s.kind === "agent" && s.canEdit)).map((s) => s.key),
    );
    const summary =
      runRows.filter((r) => builderKeys.has(r.stationKey) && r.status === "succeeded").at(-1)
        ?.output ?? null;
    const verdict = runRows.filter((r) => r.verdict).at(-1)?.verdict ?? null;
    let diffStat = "";
    try {
      diffStat = await localRunner.diffStatAgainst(input.worktreePath, input.baseBranch);
    } catch {
      // A stat is nice to have; the PR still opens without it.
    }
    let qa: PrQa | null = null;
    const qaRows = runRows.length
      ? await db
          .select()
          .from(qaRuns)
          .where(
            inArray(
              qaRuns.stationRunId,
              runRows.map((r) => r.id),
            ),
          )
          .orderBy(desc(qaRuns.startedAt))
      : [];
    const lastQa = qaRows[0];
    if (lastQa) {
      const checks = await db
        .select()
        .from(qaChecks)
        .where(eq(qaChecks.qaRunId, lastQa.id))
        .orderBy(asc(qaChecks.position));
      qa = {
        status: lastQa.status,
        attempts: qaRows.length,
        summary: lastQa.summary,
        checks: checks.map((c) => ({
          name: c.name,
          kind: c.kind,
          status: c.status,
          path: c.path,
          viewport: c.viewport,
          theme: c.theme,
          accepted: c.acceptedAt !== null,
        })),
      };
    }
    return renderPrBody({
      qa,
      description: row?.description ?? "",
      summary,
      diffStat,
      verdict,
      stations,
      estimated: runRows.some((r) => r.authSource === "subscription"),
    });
  };
}
