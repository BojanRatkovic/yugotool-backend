// Deterministic workflow code ONLY — no Node APIs, no I/O, no Date/Math.random.
import {
  GATE_DECISION_SIGNAL,
  type DeliveryMode,
  type GateDecision,
  REPO_HOOKS_STATION_KEY,
  requestChangesTarget,
  type Handoff,
  type KnowledgeMount,
  SHIFT_CONTROL_SIGNAL,
  type ShiftControl,
  type ShiftEndReason,
} from "@zastava/contracts";
import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  patched,
  setHandler,
} from "@temporalio/workflow";
import type { Activities, AgentStationResult, QaResult, ShiftResult } from "../activities";
import {
  buildPrompt,
  buildFollowUp,
  MAX_FIX_LOOPS,
  type StationNote,
  validatorPassed,
} from "./line-logic";
import {
  asShiftStation,
  canResumeShift,
  handoffFromFeedback,
  isStuck,
  type ShiftTally,
} from "./shift-logic";
import { startCiWatch } from "./watch-ci.workflow";

export const gateDecisionSignal =
  defineSignal<[GateDecision & { stationKey: string }]>(GATE_DECISION_SIGNAL);
export const shiftControlSignal = defineSignal<[ShiftControl]>(SHIFT_CONTROL_SIGNAL);

/** Bookkeeping writes: short and retried hard — losing one desyncs the board. */
const bookkeeping = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

/** Removing a worktree deletes its node_modules: can take a while on big repos. */
const housekeeping = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * Agent sessions, checks and delivery cost money or have side effects and are
 * not idempotent, so they are never retried automatically. Heartbeats let
 * cancellation reach them within seconds.
 */
const work = proxyActivities<Activities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "3 minutes",
  retry: { maximumAttempts: 1 },
});

/** Syncing knowledge can clone a repo: longer than bookkeeping, and safe to retry. */
const knowledgeSync = proxyActivities<Activities>({
  startToCloseTimeout: "20 minutes",
  retry: { maximumAttempts: 2 },
});

/** ActivityFailure wraps the real error; surface that, not "Activity task failed". */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // "Activity task failed" says nothing to a person; the cause is the reason.
  return error.cause instanceof Error ? error.cause.message : error.message;
}

export interface WorkOrderRunInput {
  runId: string;
  workOrderId: string;
}

export async function workOrderRun(input: WorkOrderRunInput): Promise<void> {
  const decisions = new Map<string, GateDecision>();
  setHandler(gateDecisionSignal, ({ stationKey, ...decision }) => {
    decisions.set(stationKey, decision);
  });
  /** "Stop after this shift" for the shift station currently running. */
  let stopAfterShift = false;
  let shiftReview: Extract<ShiftControl, { action: "review" }> | null = null;
  setHandler(shiftControlSignal, (control) => {
    if (control.action === "stop_after") stopAfterShift = true;
    else shiftReview = control;
  });
  // Signal handlers mutate these; getters stop TS from narrowing them to their initial value.
  const reviewReceived = (): Extract<ShiftControl, { action: "review" }> | null => shiftReview;
  const stopRequested = (): boolean => stopAfterShift;

  const finish = (status: "succeeded" | "failed" | "rejected" | "cancelled", reason?: string) =>
    CancellationScope.nonCancellable(async () => {
      await bookkeeping.finishRun({ ...input, status, ...(reason ? { reason } : {}) });
      // Finished runs keep their branch, not their worktree (disk space).
      if (patched("archive-worktree")) await housekeeping.archiveRun({ runId: input.runId });
    });

  try {
    const run = await bookkeeping.prepareRun(input);
    // Planning stations read the project's knowledge (spec 0007); builders never do.
    const readsKnowledge = (station: (typeof run.stations)[number]): boolean =>
      station.kind === "agent" && station.useKnowledge === true && !station.canEdit;
    const knowledge: KnowledgeMount[] =
      run.stations.some(readsKnowledge) && patched("knowledge-sources")
        ? await knowledgeSync.prepareKnowledge(input)
        : [];
    const notes: StationNote[] = [];
    /** Set by the approval at the last gate; undefined = the project's settings. */
    let delivery: DeliveryMode | undefined;
    const attempts = new Map<string, number>();
    // The station loop-backs return to: the first editing agent or shift station.
    const buildIndex = run.stations.findIndex(
      (s) => (s.kind === "agent" && s.canEdit) || s.kind === "shift",
    );
    const nextHooksAttempt = (): number => {
      const next = (attempts.get(REPO_HOOKS_STATION_KEY) ?? 0) + 1;
      attempts.set(REPO_HOOKS_STATION_KEY, next);
      return next;
    };
    /** The last gate: approval there leads straight to delivery. */
    const finalGateIndex = run.stations.findLastIndex((s) => s.kind === "gate");
    /** Shift numbers continue across loop-backs so the timeline reads 1..N. */
    let shiftNumber = 0;
    let spentUsd = 0;
    let fixLoops = 0;
    let index = 0;
    /** Each agent station's last Claude session (by line index), resumed when work comes back to it. */
    const sessions = new Map<number, string>();
    /** Each editing station's last shift (by line index): resumed when work comes back and it has room. */
    const lastShifts = new Map<number, ShiftResult>();
    // Editing agent stations work in shifts (spec 0012); runs started before replay the old path.
    const buildsInShifts = patched("build-in-shifts");
    /** Why a station is running again; null on a first pass. */
    let followUp: StationNote | null = null;
    /** The station `followUp` is for: the builder, or where a human sent changes. */
    let followUpTarget = buildIndex;
    /** The last failing QA report, so the next QA attempt re-checks it first. */
    let lastQaReport: string | null = null;

    const pendingFollowUp = (): StationNote | null => followUp;

    const sendBack = (reason: StationNote, target: number = buildIndex): void => {
      notes.push(reason);
      followUp = reason;
      followUpTarget = target;
      index = target;
    };

    /** Automatic loop-back (validator or checks failed); false when out of loops. */
    const loopBack = (reason: string, report: string): boolean => {
      if (buildIndex < 0 || fixLoops >= MAX_FIX_LOOPS) return false;
      fixLoops += 1;
      sendBack({ station: reason, text: report });
      return true;
    };

    while (index < run.stations.length) {
      const station = run.stations[index];
      if (!station) break;
      const attempt = (attempts.get(station.key) ?? 0) + 1;
      attempts.set(station.key, attempt);
      const begin = (status: "running" | "awaiting_approval") =>
        bookkeeping.beginStation({ ...input, stationKey: station.key, attempt, status });

      if (station.kind === "gate") {
        // Before the last gate (what delivery follows), make sure the repo's own
        // pre-commit hook accepts the work; otherwise it goes back to the builder.
        // patched(): runs started before this check existed replay without it.
        if (index === finalGateIndex && patched("repo-hooks-preflight")) {
          const hooks = await work.repoHooks({
            runId: input.runId,
            worktreePath: run.worktreePath,
            attempt: nextHooksAttempt(),
          });
          if (!hooks.passed) {
            const report = `The repository's pre-commit hook rejects these changes, so they cannot be committed. Fix what it reports (follow the repo's own conventions):\n\n${hooks.output}`;
            if (loopBack("Repo pre-commit hook (failed)", report)) continue;
            await finish(
              "failed",
              `Repo pre-commit hook still failing after ${MAX_FIX_LOOPS} fix loops`,
            );
            return;
          }
        }
        const stationRunId = await begin("awaiting_approval");
        await condition(() => decisions.has(station.key));
        const decision = decisions.get(station.key);
        decisions.delete(station.key);
        if (!decision) continue;
        const approved = decision.decision === "approve";
        // Older runs replay the old rule (always the builder).
        const changesTarget =
          decision.decision !== "request_changes"
            ? -1
            : patched("request-changes-nearest-agent")
              ? requestChangesTarget(run.stations, index)
              : buildIndex;
        if (decision.decision === "request_changes" && changesTarget >= 0) {
          await bookkeeping.finishStation({
            runId: input.runId,
            stationRunId,
            status: "changes_requested",
            log: true,
            output: `Changes requested: ${decision.comment}`,
          });
          // Human-requested changes are not capped: the reviewer decides when to stop.
          sendBack(
            { station: `${station.name} (changes requested)`, text: decision.comment },
            changesTarget,
          );
          continue;
        }
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: approved ? "succeeded" : "rejected",
          log: true,
          // Always leave a trace of who decided what, even without a comment.
          output: `${approved ? "Approved" : "Rejected"} at ${station.name}${decision.comment ? ` — Reviewer: ${decision.comment}` : ""}`,
        });
        if (!approved) {
          await finish(
            "rejected",
            `Rejected at ${station.name}${decision.comment ? `: ${decision.comment}` : ""}`,
          );
          return;
        }
        if (decision.comment) {
          notes.push({ station: station.name, text: `Human reviewer: ${decision.comment}` });
        }
        if (decision.delivery) delivery = decision.delivery;
        index += 1;
        continue;
      }

      if (station.kind === "checks") {
        const stationRunId = await begin("running");
        const result = await work.runChecks({
          runId: input.runId,
          stationRunId,
          station,
          worktreePath: run.worktreePath,
        });
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: result.passed ? "succeeded" : "failed",
          output: result.output,
        });
        if (!result.passed) {
          const report = `\`${station.command}\` failed:\n${result.output}`;
          if (loopBack(`${station.name} (failed)`, report)) continue;
          await finish("failed", `${station.name} still failing after ${MAX_FIX_LOOPS} fix loops`);
          return;
        }
        index += 1;
        continue;
      }

      const shiftStation =
        station.kind === "shift"
          ? station
          : station.kind === "agent" && station.canEdit && buildsInShifts
            ? asShiftStation(station)
            : null;
      if (shiftStation) {
        const autoShifts = station.kind === "agent";
        if (autoShifts && run.maxBudgetUsd !== null && spentUsd >= run.maxBudgetUsd) {
          await finish(
            "failed",
            `Budget exhausted: $${spentUsd.toFixed(2)} of $${run.maxBudgetUsd.toFixed(2)} spent before ${station.name}`,
          );
          return;
        }
        const stationRunId = await begin("running");
        const ids = { runId: input.runId, workOrderId: input.workOrderId, stationRunId };
        const pending = index === followUpTarget ? pendingFollowUp() : null;
        const startSha = await bookkeeping.prepareShiftStation({
          runId: input.runId,
          stationRunId,
          worktreePath: run.worktreePath,
          station: shiftStation,
          title: run.title,
          description: run.description,
          ...(station.kind === "agent" ? { brief: buildPrompt(run, station, notes) } : {}),
        });
        if (index === followUpTarget) followUp = null;
        const previous = lastShifts.get(index);
        // Work back at a builder whose last session finished with room left: continue it.
        let resume: { sessionId: string; prompt: string } | null =
          autoShifts && pending && canResumeShift(previous, shiftStation.handoffAtPct)
            ? { sessionId: previous.sessionId, prompt: buildFollowUp(pending, true) }
            : null;
        let handoff: Handoff | null =
          pending && !resume ? handoffFromFeedback(pending.station, pending.text) : null;
        stopAfterShift = false;
        const history: ShiftTally[] = [];
        let stationSpent = 0;
        let last: ShiftResult | null = null;
        let endReason: ShiftEndReason = "max_shifts";

        for (let n = 1; n <= shiftStation.maxShifts; n++) {
          const runLeft = run.maxBudgetUsd === null ? null : run.maxBudgetUsd - spentUsd;
          const stationLeft =
            shiftStation.maxBudgetUsd === undefined
              ? null
              : shiftStation.maxBudgetUsd - stationSpent;
          const left =
            runLeft === null
              ? stationLeft
              : stationLeft === null
                ? runLeft
                : Math.min(runLeft, stationLeft);
          if (left !== null && left <= 0) {
            endReason = "budget";
            break;
          }
          if (last && shiftStation.reviewHandoff) {
            shiftReview = null;
            await bookkeeping.awaitShiftReview({
              ...ids,
              shiftId: last.shiftId,
              number: shiftNumber,
            });
            await condition(() => reviewReceived() !== null);
            const review = reviewReceived();
            shiftReview = null;
            await bookkeeping.resolveShiftReview({
              ...ids,
              shiftId: last.shiftId,
              decision: review?.decision ?? "continue",
              handoff: review?.handoff ?? null,
            });
            if (review?.handoff) handoff = review.handoff;
            if (review?.decision === "stop") {
              endReason = "manual";
              break;
            }
          }
          shiftNumber += 1;
          const result: ShiftResult = await work.runShift({
            runId: input.runId,
            stationRunId,
            station: shiftStation,
            worktreePath: run.worktreePath,
            number: shiftNumber,
            previousHandoff: handoff,
            modelOverride: run.modelOverride,
            effortOverride: run.effortOverride,
            maxBudgetUsd: left,
            ...(resume ? { resume } : {}),
          });
          resume = null;
          last = result;
          if (autoShifts) lastShifts.set(index, result);
          spentUsd += result.costUsd;
          stationSpent += result.costUsd;
          handoff = result.handoff;
          history.push({ commits: result.commits, tasksDone: result.tasksDone });
          if (result.endReason === "done" || result.endReason === "budget") {
            endReason = result.endReason;
            break;
          }
          if (isStuck(history)) {
            endReason = "stuck";
            break;
          }
          if (result.stopAfter || stopRequested()) {
            endReason = "manual";
            break;
          }
        }

        if (last && last.endReason !== endReason) {
          await bookkeeping.endShifts({
            ...ids,
            shiftId: last.shiftId,
            number: shiftNumber,
            endReason,
          });
        }
        // Builders leave one uncommitted change behind, as before shifts (spec 0012).
        if (autoShifts && startSha) {
          await bookkeeping.foldCheckpoints({
            runId: input.runId,
            stationRunId,
            worktreePath: run.worktreePath,
            sha: startSha,
          });
        }
        const summary = last?.output ?? "";
        // A human stop or a met goal hands the work to the rest of the line.
        const passed = endReason === "done" || endReason === "manual";
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: passed ? "succeeded" : "failed",
          output: summary,
        });
        if (!passed) {
          const why =
            endReason === "stuck"
              ? `Stuck after shift ${shiftNumber}: two shifts in a row changed no code`
              : endReason === "budget"
                ? `Budget exhausted in ${station.name} after shift ${shiftNumber}`
                : `${station.name} reached ${shiftStation.maxShifts} shifts without ${autoShifts ? "finishing" : "meeting its goal"}`;
          await finish("failed", why);
          return;
        }
        notes.push({ station: station.name, text: summary });
        index += 1;
        continue;
      }

      if (station.kind === "qa") {
        if (run.maxBudgetUsd !== null && spentUsd >= run.maxBudgetUsd) {
          await finish(
            "failed",
            `Budget exhausted: $${spentUsd.toFixed(2)} of $${run.maxBudgetUsd.toFixed(2)} spent before ${station.name}`,
          );
          return;
        }
        const stationRunId = await begin("running");
        const result: QaResult = await work.runQaStation({
          runId: input.runId,
          stationRunId,
          station,
          worktreePath: run.worktreePath,
          baseBranch: run.baseBranch,
          attempt,
          title: run.title,
          description: run.description,
          modelOverride: run.modelOverride,
          effortOverride: run.effortOverride,
          previousReport: lastQaReport,
        });
        spentUsd += result.costUsd;
        await bookkeeping.finishStation({
          runId: input.runId,
          stationRunId,
          status: result.status === "passed" ? "succeeded" : "failed",
          output: result.summary,
        });
        if (result.status === "error") {
          await finish("failed", `${station.name}: ${result.summary}`);
          return;
        }
        notes.push({ station: station.name, text: result.summary });
        if (result.status === "failed") {
          lastQaReport = result.report;
          if (loopBack(`${station.name} (QA failed)`, result.report)) continue;
          await finish("failed", `${station.name} still failing after ${MAX_FIX_LOOPS} fix loops`);
          return;
        }
        lastQaReport = null;
        index += 1;
        continue;
      }

      // Shift stations were handled above; this narrows for TS.
      if (station.kind !== "agent") {
        index += 1;
        continue;
      }
      if (run.maxBudgetUsd !== null && spentUsd >= run.maxBudgetUsd) {
        await finish(
          "failed",
          `Budget exhausted: $${spentUsd.toFixed(2)} of $${run.maxBudgetUsd.toFixed(2)} spent before ${station.name}`,
        );
        return;
      }

      const stationRunId = await begin("running");
      // Mutated inside closures above, so TS cannot narrow it here; annotate explicitly.
      const pending: StationNote | null = followUp;
      const sessionId = sessions.get(index) ?? null;
      const resume: boolean = index === followUpTarget && pending !== null && sessionId !== null;
      const result: AgentStationResult = await work.runAgentStation({
        runId: input.runId,
        stationRunId,
        station,
        worktreePath: run.worktreePath,
        prompt:
          resume && pending
            ? buildFollowUp(pending, station.canEdit)
            : buildPrompt(run, station, notes, readsKnowledge(station) ? knowledge : []),
        modelOverride: run.modelOverride,
        effortOverride: run.effortOverride,
        resumeSessionId: resume ? sessionId : null,
        ...(readsKnowledge(station) && knowledge.length > 0 ? { knowledge } : {}),
      });
      if (result.sessionId) sessions.set(index, result.sessionId);
      if (index === followUpTarget) followUp = null;
      spentUsd += result.costUsd ?? 0;
      await bookkeeping.finishStation({
        runId: input.runId,
        stationRunId,
        status: result.isError ? "failed" : "succeeded",
        output: result.output,
      });
      if (result.isError) {
        await finish("failed", `${station.name} failed: ${result.output}`);
        return;
      }
      notes.push({ station: station.name, text: result.output });

      if (!station.canEdit && !validatorPassed(station, result)) {
        if (loopBack(`${station.name} (fail verdict)`, result.output)) continue;
        await finish("failed", `${station.name} still failing after ${MAX_FIX_LOOPS} fix loops`);
        return;
      }
      index += 1;
    }

    if (finalGateIndex < 0 && patched("repo-hooks-preflight")) {
      // No human gate: the hook check happens here, with nobody to send it back for.
      const hooks = await work.repoHooks({
        runId: input.runId,
        worktreePath: run.worktreePath,
        attempt: nextHooksAttempt(),
      });
      if (!hooks.passed) {
        await finish("failed", "The repo's pre-commit hook rejects the changes; see Activity");
        return;
      }
    }
    const delivered = await work.deliver({
      ...input,
      worktreePath: run.worktreePath,
      branch: run.branch,
      baseBranch: run.baseBranch,
      title: run.title,
      ...(delivery ? { delivery } : {}),
    });
    if (!delivered.ok) {
      await finish("failed", delivered.error ?? "Delivery failed");
      return;
    }
    await finish("succeeded");
    // After finishRun, which fails any station row still running.
    if (delivered.prUrl && patched("ci-watch")) await startCiWatch(input.workOrderId);
  } catch (error) {
    if (isCancellation(error)) {
      await finish("cancelled", "Cancelled by user");
      throw error;
    }
    await finish("failed", describeFailure(error));
    throw error;
  }
}
