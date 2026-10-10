import { Injectable } from "@nestjs/common";
import {
  type QaCheck,
  type QaRun,
  type Run,
  type RunEvent,
  runStatusSchema,
  type Shift,
  type ShiftStatus,
  type StationRun,
  runTarget,
} from "@zastava/contracts";
import {
  type Executor,
  projects,
  qaChecks,
  qaRuns,
  runEvents,
  runs,
  shifts,
  stationRuns,
  workOrders,
} from "@zastava/db";
import { and, asc, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { iso } from "../../common/mappers";

type StationRunRow = typeof stationRuns.$inferSelect;
type ShiftRow = typeof shifts.$inferSelect;
type QaCheckRow = typeof qaChecks.$inferSelect;
type QaSummary = NonNullable<StationRun["qa"]>;

/** A screen counts as a diff when its pixels moved, whatever the verdict. */
const isDiff = (c: Pick<QaCheckRow, "kind" | "status">): boolean =>
  c.kind === "visual" && (c.status === "fail" || c.status === "changed" || c.status === "intended");

const toQaCheck = (row: QaCheckRow): QaCheck => ({ ...row, acceptedAt: iso(row.acceptedAt) });

const toStationRun = (
  row: StationRunRow,
  latestShift: ShiftRow | null = null,
  qa: QaSummary | null = null,
): StationRun => ({
  ...row,
  qa,
  shift: latestShift
    ? {
        number: latestShift.number,
        status: latestShift.status,
        tasksDone: latestShift.tasksDone,
        tasksTotal: latestShift.tasksTotal,
      }
    : null,
  startedAt: iso(row.startedAt),
  finishedAt: iso(row.finishedAt),
});

const toShift = (row: ShiftRow & { stationKey: string }): Shift => ({
  ...row,
  startedAt: iso(row.startedAt),
  finishedAt: iso(row.finishedAt),
});

@Injectable()
export class RunsRepository {
  async listByWorkOrder(db: Executor, workOrderId: string): Promise<Run[]> {
    const runRows = await db
      .select()
      .from(runs)
      .where(eq(runs.workOrderId, workOrderId))
      .orderBy(desc(runs.startedAt));
    if (runRows.length === 0) return [];
    const stationRows = await db
      .select()
      .from(stationRuns)
      .where(
        inArray(
          stationRuns.runId,
          runRows.map((run) => run.id),
        ),
      )
      .orderBy(asc(stationRuns.startedAt));
    const shiftRows =
      stationRows.length === 0
        ? []
        : await db
            .select()
            .from(shifts)
            .where(
              inArray(
                shifts.stationRunId,
                stationRows.map((s) => s.id),
              ),
            )
            .orderBy(asc(shifts.number));
    const latestShift = new Map<string, ShiftRow>();
    for (const shift of shiftRows) latestShift.set(shift.stationRunId, shift);
    const qaSummaries = await this.qaSummaries(
      db,
      stationRows.map((s) => s.id),
    );

    return runRows.map((run) => {
      const stations = stationRows
        .filter((s) => s.runId === run.id)
        .map((s) => toStationRun(s, latestShift.get(s.id) ?? null, qaSummaries.get(s.id) ?? null));
      return {
        ...run,
        // runs and station_runs share one pg enum; a run itself never holds
        // the station-only "changes_requested", so parsing narrows it safely.
        status: runStatusSchema.parse(run.status),
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        costUsd: stations.reduce((sum, s) => sum + s.costUsd, 0),
        stations,
      };
    });
  }

  /** Latest QA attempt per station run, as counts for the stepper. */
  private async qaSummaries(
    db: Executor,
    stationRunIds: string[],
  ): Promise<Map<string, QaSummary>> {
    const result = new Map<string, QaSummary>();
    if (stationRunIds.length === 0) return result;
    const qaRows = await db
      .select()
      .from(qaRuns)
      .where(inArray(qaRuns.stationRunId, stationRunIds))
      .orderBy(asc(qaRuns.startedAt));
    if (qaRows.length === 0) return result;
    const latest = new Map<string, (typeof qaRows)[number]>();
    for (const row of qaRows) latest.set(row.stationRunId, row);
    const checks = await db
      .select({ qaRunId: qaChecks.qaRunId, kind: qaChecks.kind, status: qaChecks.status })
      .from(qaChecks)
      .where(
        inArray(
          qaChecks.qaRunId,
          [...latest.values()].map((r) => r.id),
        ),
      );
    for (const [stationRunId, qaRun] of latest) {
      const own = checks.filter((c) => c.qaRunId === qaRun.id);
      result.set(stationRunId, {
        qaRunId: qaRun.id,
        status: qaRun.status,
        total: own.length,
        passed: own.filter((c) => c.status === "pass" || c.status === "intended").length,
        failed: own.filter((c) => c.status === "fail" || c.status === "error").length,
        diffs: own.filter(isDiff).length,
      });
    }
    return result;
  }

  async listQa(db: Executor, runId: string): Promise<QaRun[]> {
    const rows = await db
      .select({ qaRun: qaRuns, stationKey: stationRuns.stationKey })
      .from(qaRuns)
      .innerJoin(stationRuns, eq(stationRuns.id, qaRuns.stationRunId))
      .where(eq(stationRuns.runId, runId))
      .orderBy(asc(qaRuns.startedAt));
    if (rows.length === 0) return [];
    const checks = await db
      .select()
      .from(qaChecks)
      .where(
        inArray(
          qaChecks.qaRunId,
          rows.map((r) => r.qaRun.id),
        ),
      )
      .orderBy(asc(qaChecks.position));
    return rows.map(({ qaRun, stationKey }, index) => ({
      ...qaRun,
      runId,
      stationKey,
      // Attempts count across the run: a loop-back starts a new station run at attempt 1 again.
      attempt: index + 1,
      checks: checks.filter((c) => c.qaRunId === qaRun.id).map(toQaCheck),
      startedAt: iso(qaRun.startedAt),
      finishedAt: iso(qaRun.finishedAt),
    }));
  }

  async findQaCheck(
    db: Executor,
    runId: string,
    checkId: string,
  ): Promise<{ id: string; status: QaCheckRow["status"] } | null> {
    const [row] = await db
      .select({ id: qaChecks.id, status: qaChecks.status })
      .from(qaChecks)
      .innerJoin(qaRuns, eq(qaRuns.id, qaChecks.qaRunId))
      .innerJoin(stationRuns, eq(stationRuns.id, qaRuns.stationRunId))
      .where(and(eq(qaChecks.id, checkId), eq(stationRuns.runId, runId)));
    return row ?? null;
  }

  async acceptQaCheck(db: Executor, checkId: string): Promise<void> {
    await db
      .update(qaChecks)
      .set({ status: "intended", acceptedAt: new Date() })
      .where(eq(qaChecks.id, checkId));
  }

  async findPendingGate(
    db: Executor,
    runId: string,
    stationKey: string,
  ): Promise<StationRun | null> {
    const [row] = await db
      .select()
      .from(stationRuns)
      .where(
        and(
          eq(stationRuns.runId, runId),
          eq(stationRuns.stationKey, stationKey),
          eq(stationRuns.status, "awaiting_approval"),
        ),
      );
    return row ? toStationRun(row) : null;
  }

  async listShifts(db: Executor, runId: string): Promise<Shift[]> {
    const rows = await db
      .select({ shift: shifts, stationKey: stationRuns.stationKey })
      .from(shifts)
      .innerJoin(stationRuns, eq(stationRuns.id, shifts.stationRunId))
      .where(eq(stationRuns.runId, runId))
      .orderBy(asc(shifts.number));
    return rows.map((row) => toShift({ ...row.shift, stationKey: row.stationKey }));
  }

  /** The run's shift in one of `statuses` (at most one shift is live at a time). */
  async findShiftByStatus(
    db: Executor,
    runId: string,
    statuses: ShiftStatus[],
  ): Promise<{ id: string } | null> {
    const [row] = await db
      .select({ id: shifts.id })
      .from(shifts)
      .innerJoin(stationRuns, eq(stationRuns.id, shifts.stationRunId))
      .where(and(eq(stationRuns.runId, runId), inArray(shifts.status, statuses)))
      .orderBy(desc(shifts.number))
      .limit(1);
    return row ?? null;
  }

  async flagShift(
    db: Executor,
    shiftId: string,
    flag: { handoffRequested: true } | { stopAfter: true },
  ): Promise<void> {
    await db.update(shifts).set(flag).where(eq(shifts.id, shiftId));
  }

  async findWorkspace(
    db: Executor,
    runId: string,
  ): Promise<{
    worktreePath: string | null;
    baseBranch: string;
    repoPath: string;
    branch: string | null;
  } | null> {
    const [row] = await db
      .select({
        worktreePath: runs.worktreePath,
        project: projects,
        runRepo: runs.repo,
        branch: workOrders.branch,
      })
      .from(runs)
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .innerJoin(projects, eq(projects.id, workOrders.projectId))
      .where(eq(runs.id, runId));
    if (!row) return null;
    // A hub run's work lives in its repo (spec 0014).
    const { repoPath, baseBranch } = runTarget(row.project, row.runRepo);
    return { worktreePath: row.worktreePath, branch: row.branch, repoPath, baseBranch };
  }

  /** What a hub run's gate needs to check a repo choice (spec 0014). */
  async findGateRepoContext(
    db: Executor,
    runId: string,
  ): Promise<{
    kind: "repo" | "hub";
    repoPath: string;
    runRepo: string | null;
    presetRepo: string | null;
    researchRepo: string | null;
  } | null> {
    const [row] = await db
      .select({
        kind: projects.kind,
        repoPath: projects.repoPath,
        runRepo: runs.repo,
        presetRepo: workOrders.repo,
      })
      .from(runs)
      .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
      .innerJoin(projects, eq(projects.id, workOrders.projectId))
      .where(eq(runs.id, runId));
    if (!row) return null;
    const [latest] = await db
      .select({ research: stationRuns.research })
      .from(stationRuns)
      .where(and(eq(stationRuns.runId, runId), isNotNull(stationRuns.research)))
      .orderBy(desc(stationRuns.startedAt))
      .limit(1);
    return { ...row, researchRepo: latest?.research?.repo ?? null };
  }

  async findWorkflowId(db: Executor, runId: string): Promise<string | null> {
    const [row] = await db
      .select({ workflowId: runs.workflowId })
      .from(runs)
      .where(eq(runs.id, runId));
    return row?.workflowId ?? null;
  }

  async listEvents(
    db: Executor,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<RunEvent[]> {
    const rows = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(limit);
    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }
}
