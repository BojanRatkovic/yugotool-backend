import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type QueueMode,
  TASK_QUEUE,
  type CreateWorkOrder,
  type UpdateWorkOrder,
  type NeedsYouItem,
  type OpenPullRequest,
  type OpenPullRequestResult,
  type SplitWorkOrder,
  type WorkOrder,
} from "@yugotool/contracts";
import { runs } from "@yugotool/db";
import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import { removeRunFiles } from "../projects/project-cleanup";
import {
  CiNotAvailableError,
  PullRequestFailedError,
  PullRequestNotPossibleError,
  WorkOrderActiveError,
  WorkOrderNotFoundError,
  WorkOrderNotQueuedError,
  WorkOrderNotSplittableError,
  WorkOrderRepoInvalidError,
  WorkOrderNotRunningError,
  WorkOrderNotStartableError,
} from "./work-order.errors";
import { hubRepos } from "../projects/work-hub";
import { followerOf, type ProjectRepos, repoProblem, splitProblem } from "./hub-work";
import { WorkOrdersRepository } from "./work-orders.repository";
import { ciRefreshMode } from "./ci-refresh";

/** Workflow type name registered by the worker. */
const WORK_ORDER_RUN_WORKFLOW = "workOrderRun";
const WATCH_CI_WORKFLOW = "watchCi";
const STARTABLE = new Set<WorkOrder["status"]>([
  "backlog",
  "queued",
  "failed",
  "rejected",
  "cancelled",
]);
const QUEUEABLE = new Set<WorkOrder["status"]>(["backlog", "failed", "rejected", "cancelled"]);

@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: WorkOrdersRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  /**
   * Work delivered locally (done, committed on its branch, no PR yet): push
   * the branch and open a PR. Waits for the worker; failures come back as
   * the reason (no origin, not GitHub, gh not logged in…).
   */
  async openPullRequest(id: string, input: OpenPullRequest): Promise<OpenPullRequestResult> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    if (workOrder.status !== "done" || !workOrder.branch) {
      throw new PullRequestNotPossibleError(
        "Only work delivered on a branch can get a pull request.",
      );
    }
    if (workOrder.prUrl) {
      throw new PullRequestNotPossibleError(
        `This work order already has a pull request: ${workOrder.prUrl}`,
      );
    }
    let result: { prUrl: string | null; error: string | null };
    try {
      result = await this.temporal.workflow.execute("openPullRequest", {
        taskQueue: TASK_QUEUE,
        workflowId: `open-pr-${id}`,
        args: [{ workOrderId: id, draft: input.draft }],
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new PullRequestNotPossibleError(
          "A pull request is already being opened for this work order.",
        );
      }
      throw error;
    }
    if (!result.prUrl) throw new PullRequestFailedError(result.error ?? "Pull request failed.");
    return { prUrl: result.prUrl };
  }

  /**
   * Look at the PR's CI again (a rerun on Semaphore/Actions, a new push). The
   * worker records the result; one watch per work order, so a refresh while
   * one runs is a no-op.
   */
  async refreshCi(id: string): Promise<void> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    if (!workOrder.prUrl) throw new CiNotAvailableError("This work order has no pull request.");
    const mode = ciRefreshMode(workOrder.ci, await this.deliveredAt(workOrder.currentRunId));
    await this.temporal.workflow.start(WATCH_CI_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      workflowId: `ci-${id}`,
      workflowIdConflictPolicy: "USE_EXISTING",
      args: [{ workOrderId: id, mode }],
    });
  }

  /** When the latest run delivered (finished as succeeded); null otherwise. */
  private async deliveredAt(runId: string | null): Promise<Date | null> {
    if (!runId) return null;
    const [run] = await this.database.db
      .select({ status: runs.status, finishedAt: runs.finishedAt })
      .from(runs)
      .where(eq(runs.id, runId));
    return run?.status === "succeeded" ? run.finishedAt : null;
  }

  needsYou(): Promise<NeedsYouItem[]> {
    return this.repository.listAwaitingApproval(this.database.db);
  }

  running(): Promise<NeedsYouItem[]> {
    return this.repository.listRunning(this.database.db);
  }

  list(projectId: string): Promise<WorkOrder[]> {
    return this.repository.list(this.database.db, projectId);
  }

  async create(input: CreateWorkOrder): Promise<WorkOrder> {
    const problem = repoProblem(await this.projectRepos(input.projectId), input.repo);
    if (problem) throw new WorkOrderRepoInvalidError(problem);
    const position =
      input.position ?? (await this.repository.nextPosition(this.database.db, input.projectId));
    const workOrder = await this.repository.insert(this.database.db, { ...input, position });
    await this.notify();
    return workOrder;
  }

  /**
   * Accepts Research's split (spec 0014): this work order keeps item 1 (its
   * repo set, title kept); items 2..N become backlog work orders on their
   * repos, each following the previous one. Idempotent: a work order that
   * already has followers returns its chain unchanged.
   */
  async split(id: string, input: SplitWorkOrder): Promise<WorkOrder[]> {
    const chain = await this.database.transaction(async (tx) => {
      const workOrder = await this.repository.find(tx, id);
      if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
      const existing = await this.repository.followers(tx, id);
      if (existing.length) return [workOrder, ...existing];
      const project = await this.projectRepos(workOrder.projectId);
      const problem = splitProblem(workOrder, project, input.items);
      if (problem) throw new WorkOrderNotSplittableError(problem);
      const [first, ...rest] = input.items;
      const head =
        (first && (await this.repository.update(tx, id, { repo: first.repo }))) ?? workOrder;
      const created: WorkOrder[] = [];
      let previous = head.id;
      for (const item of rest) {
        const position = await this.repository.nextPosition(tx, workOrder.projectId);
        const follower = await this.repository.insert(tx, {
          projectId: workOrder.projectId,
          position,
          ...followerOf(item, previous),
        });
        created.push(follower);
        previous = follower.id;
      }
      return [head, ...created];
    });
    await this.notify();
    return chain;
  }

  /** A project's kind and, for a hub, its repos on disk. */
  private async projectRepos(projectId: string): Promise<ProjectRepos> {
    const project = await this.repository.projectOf(this.database.db, projectId);
    if (project?.kind !== "hub") return { kind: "repo", repos: [] };
    return { kind: "hub", repos: hubRepos(project.repoPath).map((r) => r.name) };
  }

  async update(id: string, patch: UpdateWorkOrder): Promise<WorkOrder> {
    const workOrder = await this.repository.update(this.database.db, id, patch);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    await this.notify();
    return workOrder;
  }

  /**
   * Deletes the order with its run history, then its worktrees and artifacts
   * on disk. Refused while an agent is on it or it waits at a gate; a queued
   * order just leaves the queue. Branches are kept. Idempotent: an order
   * that's already gone is a no-op (offline replay).
   */
  async delete(id: string): Promise<void> {
    const removed = await this.database.transaction(async (tx) => {
      const found = await this.repository.lockForDelete(tx, id);
      if (!found) return null;
      if (found.status === "running" || found.status === "awaiting_approval") {
        throw new WorkOrderActiveError(
          "An agent is on this work order or it's waiting at a gate. Cancel the run first.",
        );
      }
      const files = await this.repository.runFiles(tx, id);
      await this.repository.delete(tx, id);
      return { repoPath: found.repoPath, kind: found.kind, files };
    });
    if (!removed) return;
    await this.temporal.workflow
      .getHandle(`ci-${id}`)
      .terminate("work order deleted")
      .catch(() => undefined);
    const failed = await removeRunFiles({
      kind: removed.kind,
      repoPath: removed.repoPath,
      worktrees: removed.files.flatMap((f) =>
        f.worktreePath ? [{ runId: f.runId, worktreePath: f.worktreePath, repo: f.repo }] : [],
      ),
      runIds: removed.files.map((f) => f.runId),
    });
    if (failed.length) this.logger.warn(`could not remove: ${failed.join(", ")}`);
    await this.notifyQueue();
    await this.events.publish({ type: "invalidate", collection: "runs" });
  }

  /**
   * Creates the run row first, then starts the workflow. If Temporal refuses,
   * the run is marked failed so the board never shows a phantom "running".
   */
  async start(id: string): Promise<WorkOrder> {
    const run = await this.database.transaction(async (tx) => {
      const workOrder = await this.repository.find(tx, id);
      if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
      if (!STARTABLE.has(workOrder.status)) {
        throw new WorkOrderNotStartableError(`work order is ${workOrder.status}`);
      }
      const [inserted] = await tx
        .insert(runs)
        .values({ workOrderId: id, workflowId: "pending" })
        .returning();
      if (!inserted) throw new Error("run insert returned nothing");
      const workflowId = `run-${inserted.id}`;
      await tx.update(runs).set({ workflowId }).where(eq(runs.id, inserted.id));
      await this.repository.update(tx, id, {
        queueMode: null,
        queuedAt: null,
        status: "running",
        currentRunId: inserted.id,
        stationKey: null,
      });
      return { id: inserted.id, workflowId };
    });

    try {
      await this.temporal.workflow.start(WORK_ORDER_RUN_WORKFLOW, {
        taskQueue: TASK_QUEUE,
        workflowId: run.workflowId,
        args: [{ runId: run.id, workOrderId: id }],
      });
    } catch (error) {
      this.logger.error(
        `failed to start workflow for run ${run.id}`,
        error instanceof Error ? error.stack : error,
      );
      await this.database.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ status: "failed", finishedAt: new Date() })
          .where(eq(runs.id, run.id));
        await this.repository.update(tx, id, { status: "failed" });
      });
      await this.notify();
      throw error;
    }

    await this.notify();
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    return workOrder;
  }

  async enqueue(id: string, mode: QueueMode): Promise<WorkOrder> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    if (!QUEUEABLE.has(workOrder.status)) {
      throw new WorkOrderNotStartableError(`work order is ${workOrder.status}`);
    }
    const queued = await this.repository.update(this.database.db, id, {
      status: "queued",
      queueMode: mode,
      queuedAt: new Date(),
    });
    await this.notifyQueue();
    return queued ?? workOrder;
  }

  async dequeue(id: string): Promise<WorkOrder> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    if (workOrder.status !== "queued") {
      throw new WorkOrderNotQueuedError(`work order is ${workOrder.status}`);
    }
    const updated = await this.repository.update(this.database.db, id, {
      status: "backlog",
      queueMode: null,
      queuedAt: null,
    });
    await this.notifyQueue();
    return updated ?? workOrder;
  }

  async enqueueBacklog(projectId: string, mode: QueueMode): Promise<{ queued: number }> {
    const queued = await this.repository.enqueueBacklog(this.database.db, projectId, mode);
    await this.notifyQueue();
    return { queued };
  }

  private async notifyQueue(): Promise<void> {
    await this.events.publish({ type: "invalidate", collection: "work_orders" });
    await this.events.publish({ type: "invalidate", collection: "dispatcher" });
  }

  async cancel(id: string): Promise<void> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder) throw new WorkOrderNotFoundError(`work order ${id} not found`);
    if (!workOrder.currentRunId || !["running", "awaiting_approval"].includes(workOrder.status)) {
      throw new WorkOrderNotRunningError(`work order is ${workOrder.status}`);
    }
    // The workflow's cancellation scope marks rows cancelled and cleans up.
    await this.temporal.workflow.getHandle(`run-${workOrder.currentRunId}`).cancel();
  }

  /** Local runner only: opens the run's worktree in VS Code on this machine. */
  async openInEditor(id: string): Promise<void> {
    const workOrder = await this.repository.find(this.database.db, id);
    if (!workOrder?.currentRunId) throw new WorkOrderNotFoundError(`work order ${id} has no run`);
    const [run] = await this.database.db
      .select({ worktreePath: runs.worktreePath })
      .from(runs)
      .where(eq(runs.id, workOrder.currentRunId));
    if (!run?.worktreePath || !existsSync(run.worktreePath)) {
      throw new WorkOrderNotFoundError("the run's worktree no longer exists");
    }
    spawn("code", [run.worktreePath], { detached: true, stdio: "ignore" }).unref();
  }

  private async notify(): Promise<void> {
    await this.events.publish({ type: "invalidate", collection: "work_orders" });
    await this.events.publish({ type: "invalidate", collection: "runs" });
  }
}
