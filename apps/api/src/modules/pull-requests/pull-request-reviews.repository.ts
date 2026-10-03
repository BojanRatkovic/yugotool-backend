import { Injectable } from "@nestjs/common";
import type {
  ReviewPullRequest,
  ReviewVerdict,
  RunStatus,
  ZastavaReviewBrief,
} from "@zastava/contracts";
import { type Executor, runEvents, runs, stationRuns, workOrders } from "@zastava/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

/** A review work order with what its latest run produced so far. */
export interface ReviewRow {
  workOrderId: string;
  runId: string | null;
  runStatus: RunStatus | null;
  pullRequest: ReviewPullRequest;
  costUsd: number;
  verdict: ReviewVerdict | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const forPr = (projectId: string, number: number) =>
  and(
    eq(workOrders.projectId, projectId),
    eq(workOrders.kind, "review"),
    sql`(${workOrders.pullRequest}->>'number')::int = ${number}`,
  );

/** Review work orders (spec 0009): all SQL for ZASTAVA reviews of pull requests. */
@Injectable()
export class PullRequestReviewsRepository {
  /** The newest review of a PR, with its run's cost, verdict and failure reason. */
  async latest(db: Executor, projectId: string, number: number): Promise<ReviewRow | null> {
    const [row] = await db
      .select({ workOrder: workOrders, run: runs })
      .from(workOrders)
      .leftJoin(runs, eq(runs.id, workOrders.currentRunId))
      .where(forPr(projectId, number))
      .orderBy(desc(workOrders.createdAt))
      .limit(1);
    if (!row?.workOrder.pullRequest) return null;
    return this.toRow(
      db,
      row.workOrder.id,
      row.workOrder.pullRequest,
      row.run,
      row.workOrder.createdAt,
    );
  }

  async find(db: Executor, workOrderId: string): Promise<ReviewRow | null> {
    const [row] = await db
      .select({ workOrder: workOrders, run: runs })
      .from(workOrders)
      .leftJoin(runs, eq(runs.id, workOrders.currentRunId))
      .where(and(eq(workOrders.id, workOrderId), eq(workOrders.kind, "review")));
    if (!row?.workOrder.pullRequest) return null;
    return this.toRow(
      db,
      row.workOrder.id,
      row.workOrder.pullRequest,
      row.run,
      row.workOrder.createdAt,
    );
  }

  private async toRow(
    db: Executor,
    workOrderId: string,
    pullRequest: ReviewPullRequest,
    run: typeof runs.$inferSelect | null,
    createdAt: Date,
  ): Promise<ReviewRow> {
    if (!run) {
      return {
        workOrderId,
        runId: null,
        runStatus: null,
        pullRequest,
        costUsd: 0,
        verdict: null,
        error: null,
        startedAt: createdAt,
        finishedAt: null,
      };
    }
    const [cost] = await db
      .select({ usd: sql<number>`coalesce(sum(${stationRuns.costUsd}), 0)::float8` })
      .from(stationRuns)
      .where(eq(stationRuns.runId, run.id));
    const [review] = await db
      .select({ review: stationRuns.review })
      .from(stationRuns)
      .where(and(eq(stationRuns.runId, run.id), isNotNull(stationRuns.review)))
      .orderBy(desc(stationRuns.startedAt))
      .limit(1);
    const [error] =
      run.status === "failed"
        ? await db
            .select({ message: runEvents.message })
            .from(runEvents)
            .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "error")))
            .orderBy(desc(runEvents.seq))
            .limit(1)
        : [];
    return {
      workOrderId,
      runId: run.id,
      // The shared pg enum also has the station-only "changes_requested"; runs never use it.
      runStatus: run.status === "changes_requested" ? "running" : run.status,
      pullRequest,
      costUsd: cost?.usd ?? 0,
      verdict: review?.review ?? null,
      error: error?.message ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  /** Every PR's latest review in the project, with its finding counts. */
  async briefs(db: Executor, projectId: string): Promise<ZastavaReviewBrief[]> {
    const latest = await db
      .selectDistinctOn([sql`(${workOrders.pullRequest}->>'number')::int`], {
        pullRequest: workOrders.pullRequest,
        runId: workOrders.currentRunId,
        runStatus: runs.status,
      })
      .from(workOrders)
      .leftJoin(runs, eq(runs.id, workOrders.currentRunId))
      .where(and(eq(workOrders.projectId, projectId), eq(workOrders.kind, "review")))
      .orderBy(sql`(${workOrders.pullRequest}->>'number')::int`, desc(workOrders.createdAt));
    const runIds = latest.flatMap((r) => (r.runId ? [r.runId] : []));
    const reviews =
      runIds.length === 0
        ? []
        : await db
            .selectDistinctOn([stationRuns.runId], {
              runId: stationRuns.runId,
              review: stationRuns.review,
            })
            .from(stationRuns)
            .where(and(inArray(stationRuns.runId, runIds), isNotNull(stationRuns.review)))
            .orderBy(stationRuns.runId, desc(stationRuns.startedAt));
    const byRun = new Map(reviews.map((r) => [r.runId, r.review]));
    return latest.flatMap((r) => {
      if (!r.pullRequest) return [];
      const review = r.runId ? byRun.get(r.runId) : undefined;
      const status = r.runStatus ?? "running";
      return [
        {
          number: r.pullRequest.number,
          status: status === "changes_requested" ? "running" : status,
          headOid: r.pullRequest.headOid,
          findings: review ? review.findings.length : null,
          posted: r.pullRequest.posted.length,
        },
      ];
    });
  }

  async isRunning(db: Executor, projectId: string, number: number): Promise<boolean> {
    const rows = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(forPr(projectId, number), eq(workOrders.status, "running")))
      .limit(1);
    return rows.length > 0;
  }

  /** Head commit of the PR's last successful review: a re-review starts from there. */
  async lastReviewedHead(db: Executor, projectId: string, number: number): Promise<string | null> {
    const [row] = await db
      .select({ pullRequest: workOrders.pullRequest })
      .from(workOrders)
      .where(and(forPr(projectId, number), eq(workOrders.status, "done")))
      .orderBy(desc(workOrders.createdAt))
      .limit(1);
    return row?.pullRequest?.headOid ?? null;
  }

  async exists(db: Executor, workOrderId: string): Promise<boolean> {
    const rows = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId));
    return rows.length > 0;
  }

  /** The review work order and its run, already running; returns the run's ids. */
  async insertRunning(
    db: Executor,
    values: {
      id?: string | undefined;
      projectId: string;
      title: string;
      description: string;
      pullRequest: ReviewPullRequest;
    },
  ): Promise<{ workOrderId: string; runId: string; workflowId: string }> {
    const [workOrder] = await db
      .insert(workOrders)
      .values({ ...values, kind: "review", status: "running", position: 0 })
      .returning({ id: workOrders.id });
    if (!workOrder) throw new Error("review work order insert returned nothing");
    const [run] = await db
      .insert(runs)
      .values({ workOrderId: workOrder.id, workflowId: "pending" })
      .returning({ id: runs.id });
    if (!run) throw new Error("run insert returned nothing");
    const workflowId = `run-${run.id}`;
    await db.update(runs).set({ workflowId }).where(eq(runs.id, run.id));
    await db
      .update(workOrders)
      .set({ currentRunId: run.id })
      .where(eq(workOrders.id, workOrder.id));
    return { workOrderId: workOrder.id, runId: run.id, workflowId };
  }

  /** Remembers which findings are in the pending review on GitHub (set union). */
  async markPosted(db: Executor, workOrderId: string, ids: string[]): Promise<void> {
    const [row] = await db
      .select({ pullRequest: workOrders.pullRequest })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId));
    if (!row?.pullRequest) return;
    const posted = [...new Set([...row.pullRequest.posted, ...ids])];
    await db
      .update(workOrders)
      .set({ pullRequest: { ...row.pullRequest, posted } })
      .where(eq(workOrders.id, workOrderId));
  }

  async markFailed(db: Executor, workOrderId: string, runId: string): Promise<void> {
    await db
      .update(runs)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(runs.id, runId));
    await db.update(workOrders).set({ status: "failed" }).where(eq(workOrders.id, workOrderId));
  }
}
