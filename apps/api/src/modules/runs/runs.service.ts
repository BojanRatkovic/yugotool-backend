import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import {
  GATE_DECISION_SIGNAL,
  type GateDecision,
  parseShiftTasks,
  type QaRun,
  type Run,
  type RunDiff,
  type RunEvent,
  type RunMemory,
  SHIFT_CONTROL_SIGNAL,
  type Shift,
  type ShiftControl,
  type ShiftReview,
} from "@yugotool/contracts";
import type { Client } from "@temporalio/client";
import { resolveInside, runArtifactsDir } from "../../core/artifacts/artifacts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import {
  ArtifactNotFoundError,
  GateNotPendingError,
  GateRepoInvalidError,
  QaCheckNotAcceptableError,
  QaCheckNotFoundError,
  RunNotFoundError,
  ShiftNotRunningError,
  ShiftReviewNotPendingError,
  WorkspaceGoneError,
} from "./run.errors";
import { hubRepos } from "../projects/work-hub";
import { branchDiff, gitCapped, worktreeDiff } from "./git-diff";
import { gateRepoProblem } from "./hub-gate";
import { RunsRepository } from "./runs.repository";

/** Shift station memory inside the worktree (written by the worker). */
const MEMORY_DIR = ".yugotool";
/** A diff bigger than this is unreadable in a sheet anyway. */
const MAX_PATCH_CHARS = 200_000;
/** A `--stat` past this is cut and closed with the `--shortstat` totals. */
const MAX_STAT_CHARS = 50_000;

@Injectable()
export class RunsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: RunsRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  list(workOrderId: string): Promise<Run[]> {
    return this.repository.listByWorkOrder(this.database.db, workOrderId);
  }

  listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEvent[]> {
    return this.repository.listEvents(this.database.db, runId, afterSeq, limit);
  }

  /** Worktree vs the base branch: committed and uncommitted changes, new files included. */
  async diff(runId: string): Promise<RunDiff> {
    const workspace = await this.repository.findWorkspace(this.database.db, runId);
    if (!workspace) throw new RunNotFoundError(`run ${runId} not found`);
    const limits = { patchChars: MAX_PATCH_CHARS, statChars: MAX_STAT_CHARS };
    const cwd = workspace.worktreePath;
    if (cwd && existsSync(cwd)) return worktreeDiff(cwd, workspace.baseBranch, limits);
    // Finished runs: the worktree was removed, the branch holds the work.
    if (workspace.branch && (await branchExists(workspace.repoPath, workspace.branch)))
      return branchDiff(workspace.repoPath, workspace.branch, workspace.baseBranch, limits);
    throw new WorkspaceGoneError("the run's worktree and branch no longer exist");
  }

  /** The workflow owns state transitions; the API only validates and signals. */
  async decideGate(runId: string, stationKey: string, decision: GateDecision): Promise<void> {
    const workflowId = await this.repository.findWorkflowId(this.database.db, runId);
    if (!workflowId) throw new RunNotFoundError(`run ${runId} not found`);
    const gate = await this.repository.findPendingGate(this.database.db, runId, stationKey);
    if (!gate) throw new GateNotPendingError(`gate ${stationKey} is not awaiting approval`);
    const ctx = await this.repository.findGateRepoContext(this.database.db, runId);
    if (!ctx) throw new RunNotFoundError(`run ${runId} not found`);
    const repos = ctx.kind === "hub" ? hubRepos(ctx.repoPath).map((r) => r.name) : [];
    const problem = gateRepoProblem({ ...ctx, repos }, decision);
    if (problem) throw new GateRepoInvalidError(problem);
    await this.temporal.workflow
      .getHandle(workflowId)
      .signal(GATE_DECISION_SIGNAL, { stationKey, ...decision });
  }

  listShifts(runId: string): Promise<Shift[]> {
    return this.repository.listShifts(this.database.db, runId);
  }

  async memory(runId: string): Promise<RunMemory> {
    const workspace = await this.repository.findWorkspace(this.database.db, runId);
    if (!workspace) throw new RunNotFoundError(`run ${runId} not found`);
    // Live in the worktree; copied to the run's artifacts when the worktree is removed.
    const cwd = workspace.worktreePath;
    const dir =
      cwd && existsSync(cwd)
        ? path.join(cwd, MEMORY_DIR)
        : path.join(runArtifactsDir(runId), "memory");
    if (!existsSync(dir)) throw new WorkspaceGoneError("the run's shift memory no longer exists");
    const read = (file: string): Promise<string | null> =>
      readFile(path.join(dir, file), "utf8").catch(() => null);
    const [goal, tasks, progress, learnings] = await Promise.all([
      read("goal.md"),
      read("tasks.json"),
      read("progress.md"),
      read("learnings.md"),
    ]);
    return { goal, tasks: parseShiftTasks(tasks), progress, learnings };
  }

  /** The worker polls the flag and hands off at the next turn boundary. */
  async requestHandoff(runId: string): Promise<void> {
    const shift = await this.repository.findShiftByStatus(this.database.db, runId, ["running"]);
    if (!shift) throw new ShiftNotRunningError(`run ${runId} has no running shift`);
    await this.repository.flagShift(this.database.db, shift.id, { handoffRequested: true });
    await this.events.publish({ type: "invalidate", collection: "shifts" });
  }

  async stopAfterShift(runId: string): Promise<void> {
    const shift = await this.repository.findShiftByStatus(this.database.db, runId, [
      "running",
      "handing_off",
    ]);
    if (!shift) throw new ShiftNotRunningError(`run ${runId} has no running shift`);
    await this.repository.flagShift(this.database.db, shift.id, { stopAfter: true });
    await this.signalShift(runId, { action: "stop_after" });
    await this.events.publish({ type: "invalidate", collection: "shifts" });
  }

  async reviewShift(runId: string, review: ShiftReview): Promise<void> {
    const shift = await this.repository.findShiftByStatus(this.database.db, runId, [
      "awaiting_review",
    ]);
    if (!shift) throw new ShiftReviewNotPendingError(`run ${runId} has no handoff awaiting review`);
    await this.signalShift(runId, {
      action: "review",
      decision: review.decision,
      ...(review.handoff ? { handoff: review.handoff } : {}),
    });
  }

  listQa(runId: string): Promise<QaRun[]> {
    return this.repository.listQa(this.database.db, runId);
  }

  /** Absolute path of a QA artifact; confined to the run's artifact dir. */
  async qaFile(runId: string, relative: string): Promise<string> {
    const file = await resolveInside(runArtifactsDir(runId), relative);
    if (!file || !file.endsWith(".png")) throw new ArtifactNotFoundError(`no artifact ${relative}`);
    return file;
  }

  /** A human override: the check is intended. Only this run's display and PR body change. */
  async acceptQaCheck(runId: string, checkId: string): Promise<void> {
    const check = await this.repository.findQaCheck(this.database.db, runId, checkId);
    if (!check) throw new QaCheckNotFoundError(`qa check ${checkId} not found in run ${runId}`);
    if (check.status !== "fail" && check.status !== "changed") {
      throw new QaCheckNotAcceptableError(`a ${check.status} check cannot be accepted`);
    }
    await this.repository.acceptQaCheck(this.database.db, checkId);
    await this.events.publish({ type: "invalidate", collection: "qa" });
    await this.events.publish({ type: "invalidate", collection: "runs" });
  }

  private async signalShift(runId: string, control: ShiftControl): Promise<void> {
    const workflowId = await this.repository.findWorkflowId(this.database.db, runId);
    if (!workflowId) throw new RunNotFoundError(`run ${runId} not found`);
    await this.temporal.workflow.getHandle(workflowId).signal(SHIFT_CONTROL_SIGNAL, control);
  }
}

function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return gitCapped(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    200,
  ).then(
    () => true,
    () => false,
  );
}
