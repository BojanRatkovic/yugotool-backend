import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "@temporalio/activity";
import {
  type Effort,
  HANDOFF_JSON_SCHEMA,
  type Handoff,
  handoffSchema,
  type RunEventType,
  type ServerEvent,
  type ShiftEndReason,
  type ShiftStation,
  type Station,
} from "@zastava/contracts";
import { type Database, runs, shifts, stationRuns, workOrders } from "@zastava/db";
import { eq, sql } from "drizzle-orm";
import { localRunner } from "../runner/local-runner";
import { withApiKey } from "../claude-env";
import { sandboxFor } from "../runner/sandbox";
import { shiftMemory } from "../runner/shift-memory";
import { hubSession } from "../runner/work-hub";
import {
  buildHandoffPrompt,
  buildShiftPrompt,
  contextPct,
  DEFAULT_CONTEXT_WINDOW,
  effectiveHandoffTokens,
  lastProgressEntries,
  renderGoal,
  relativeToWorktree,
  renderProgressEntry,
} from "../workflows/shift-logic";

/** How often a running shift heartbeats and checks for "Handoff now". */
const POLL_MS = 3_000;
/** API turns whose context counts as the session's starting point (before real work). */
const BASELINE_TURNS = 2;
/** Turns a single shift may take; the context threshold normally ends it far earlier. */
const MAX_SHIFT_TURNS = 200;

export interface ShiftDeps {
  appendEvent(
    runId: string,
    stationRunId: string | null,
    type: RunEventType,
    message: string,
  ): Promise<void>;
  notify(event: ServerEvent): Promise<void>;
  invalidateBoard(): Promise<void>;
  notifyHumans(
    workOrderId: string,
    compose: (
      title: string,
      line: Station[],
      prUrl: string | null,
    ) => { title: string; body: string },
  ): Promise<void>;
}

export interface ShiftResult {
  shiftId: string;
  sessionId: string | null;
  endReason: ShiftEndReason;
  handoff: Handoff | null;
  output: string;
  costUsd: number;
  commits: number;
  tasksDone: number;
  tasksTotal: number;
  /** "Stop after this shift" was pressed while it ran. */
  stopAfter: boolean;
  /** Context used when the shift ended, percent of the window. */
  contextPct: number;
}

/** A push-based prompt stream: keeps the session open so it can be interrupted. */
function createInput(): {
  push(text: string): void;
  close(): void;
  stream: AsyncIterable<SDKUserMessage>;
} {
  const items: SDKUserMessage[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push(text) {
      items.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      poke();
    },
    close() {
      closed = true;
      poke();
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = items.shift();
          if (next) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

export function createShiftActivities(db: Database, deps: ShiftDeps) {
  const invalidateShifts = (): Promise<void> =>
    deps.notify({ type: "invalidate", collection: "shifts" });

  async function setStatuses(
    input: { runId: string; workOrderId: string; stationRunId: string },
    status: "running" | "awaiting_approval",
  ): Promise<void> {
    await db.update(stationRuns).set({ status }).where(eq(stationRuns.id, input.stationRunId));
    await db.update(runs).set({ status }).where(eq(runs.id, input.runId));
    await db.update(workOrders).set({ status }).where(eq(workOrders.id, input.workOrderId));
  }

  /** Writes memory, commits a checkpoint and stores the shift's final numbers. */
  async function closeShift(input: {
    runId: string;
    stationRunId: string;
    worktreePath: string;
    number: number;
    shiftId: string;
    sessionId: string | null;
    endReason: ShiftEndReason;
    handoff: Handoff | null;
    output: string;
    costUsd: number;
    contextTokens: number;
    contextWindow: number;
    numTurns: number;
    startSha: string;
  }): Promise<ShiftResult> {
    if (input.handoff) {
      input.handoff = {
        ...input.handoff,
        filesToRead: input.handoff.filesToRead.map((file) =>
          relativeToWorktree(file, input.worktreePath),
        ),
      };
    }
    const pct = contextPct(input.contextTokens, input.contextWindow);
    await shiftMemory.appendProgress(
      input.worktreePath,
      renderProgressEntry({
        number: input.number,
        endReason: input.endReason,
        contextPct: pct,
        handoff: input.handoff,
        output: input.output,
      }),
    );
    if (input.handoff)
      await shiftMemory.appendLearnings(input.worktreePath, input.number, input.handoff.gotchas);

    const firstLine =
      (input.handoff?.summary ?? input.output).split("\n")[0]?.trim().slice(0, 72) ||
      input.endReason;
    const sha = await localRunner.checkpoint(
      input.worktreePath,
      `zastava: shift ${input.number} — ${firstLine}`,
    );
    if (sha) await deps.appendEvent(input.runId, input.stationRunId, "system", `Checkpoint ${sha}`);
    const commits = await localRunner.commitsSince(input.worktreePath, input.startSha);
    const tasks = shiftMemory.countTasks((await shiftMemory.read(input.worktreePath)).tasks);

    const [row] = await db
      .update(shifts)
      .set({
        status: "done",
        endReason: input.endReason,
        handoff: input.handoff,
        costUsd: input.costUsd,
        contextTokens: input.contextTokens,
        contextWindow: input.contextWindow,
        numTurns: input.numTurns,
        commits,
        tasksDone: tasks.done,
        tasksTotal: tasks.total,
        finishedAt: new Date(),
      })
      .where(eq(shifts.id, input.shiftId))
      .returning({ stopAfter: shifts.stopAfter });
    await db
      .update(stationRuns)
      .set({
        costUsd: sql`(SELECT coalesce(sum(${shifts.costUsd}), 0) FROM ${shifts} WHERE ${shifts.stationRunId} = ${input.stationRunId})`,
        numTurns: sql`(SELECT coalesce(sum(${shifts.numTurns}), 0) FROM ${shifts} WHERE ${shifts.stationRunId} = ${input.stationRunId})`,
      })
      .where(eq(stationRuns.id, input.stationRunId));
    await deps.appendEvent(
      input.runId,
      input.stationRunId,
      "system",
      `Shift ${input.number} ended (${input.endReason}) · ${pct}% context · ${tasks.done}/${tasks.total} tasks · ${commits} commit${commits === 1 ? "" : "s"} · $${input.costUsd.toFixed(4)}`,
    );
    await invalidateShifts();
    await deps.invalidateBoard();

    return {
      shiftId: input.shiftId,
      sessionId: input.sessionId,
      endReason: input.endReason,
      handoff: input.handoff,
      output: input.handoff?.summary ?? input.output,
      costUsd: input.costUsd,
      commits,
      tasksDone: tasks.done,
      tasksTotal: tasks.total,
      stopAfter: row?.stopAfter ?? false,
      contextPct: pct,
    };
  }

  return {
    async prepareShiftStation(input: {
      runId: string;
      stationRunId: string;
      worktreePath: string;
      station: ShiftStation;
      title: string;
      description: string;
      /** Editing agent stations (spec 0012): their brief becomes the goal. */
      brief?: string;
    }): Promise<string> {
      await shiftMemory.prepare(
        input.worktreePath,
        renderGoal({
          title: input.title,
          description: input.description,
          station: input.station,
          ...(input.brief ? { brief: input.brief } : {}),
        }),
      );
      // A builder's shifts are routine: one line only when the work needs more than one.
      if (!input.brief) {
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          "system",
          `Shift station ready: handoff at ${input.station.handoffAtPct}% context, up to ${input.station.maxShifts} shifts${input.station.doneCommand ? `, done when \`${input.station.doneCommand}\` passes` : ""}`,
        );
      }
      // Where this pass started: its checkpoints are folded back from here (foldCheckpoints).
      return localRunner.headSha(input.worktreePath);
    },

    /**
     * An editing station's checkpoint commits become working-tree changes
     * again when it ends, so validators and delivery see one uncommitted
     * change, as they did before builders worked in shifts.
     */
    async foldCheckpoints(input: {
      runId: string;
      stationRunId: string;
      worktreePath: string;
      sha: string;
    }): Promise<void> {
      const undone = await localRunner.uncommitSince(input.worktreePath, input.sha);
      if (undone > 1) {
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          "system",
          `Folded ${undone} shift checkpoints back into the working tree; delivery commits them once.`,
        );
      }
    },

    /**
     * One shift = one fresh Claude session. Streaming input keeps the session
     * open so the worker can interrupt it at a turn boundary once the context
     * crosses the threshold; the handoff is then a resumed turn with a JSON schema.
     */
    async runShift(input: {
      runId: string;
      stationRunId: string;
      station: ShiftStation;
      worktreePath: string;
      number: number;
      previousHandoff: Handoff | null;
      modelOverride: string | null;
      effortOverride: Effort | null;
      /** Remaining station/run budget for this session, if capped. */
      maxBudgetUsd: number | null;
      /** Work came back: continue this session with `prompt` instead of a fresh shift. */
      resume?: { sessionId: string; prompt: string } | null;
    }): Promise<ShiftResult> {
      const { station } = input;
      const model = input.modelOverride ?? station.model;
      const effort = input.effortOverride ?? station.effort;
      const ctx = Context.current();
      const abortController = new AbortController();
      ctx.cancellationSignal.addEventListener("abort", () => abortController.abort());

      const [shift] = await db
        .insert(shifts)
        .values({
          stationRunId: input.stationRunId,
          number: input.number,
          handoffAtPct: station.handoffAtPct,
        })
        .returning({ id: shifts.id });
      if (!shift) throw new Error("shift insert returned nothing");
      const shiftId = shift.id;
      await deps.appendEvent(
        input.runId,
        input.stationRunId,
        "system",
        `Shift ${input.number} started`,
      );
      await invalidateShifts();

      const memory = await shiftMemory.read(input.worktreePath);
      const startSha = await localRunner.headSha(input.worktreePath);
      const prompt =
        input.resume?.prompt ??
        buildShiftPrompt({
          number: input.number,
          station,
          goal: memory.goal ?? "",
          previousHandoff: input.previousHandoff,
          recentProgress: lastProgressEntries(memory.progress ?? ""),
          gitLog: await localRunner.recentLog(input.worktreePath),
        });

      const hub = await hubSession(input.worktreePath);
      const readRoots = hub?.readRoots ?? [];
      const tools = [...station.allowedTools, ...(hub?.tools ?? [])];
      const sandboxed = await withApiKey(await sandboxFor(input.worktreePath, { readRoots }));
      const baseOptions = {
        cwd: input.worktreePath,
        model,
        ...(effort ? { effort } : {}),
        tools,
        allowedTools: tools,
        ...(readRoots.length > 0 ? { additionalDirectories: readRoots } : {}),
        ...(hub?.plugins.length ? { plugins: hub.plugins } : {}),
        permissionMode: "dontAsk" as const,
        ...sandboxed,
        settingSources: ["project" as const],
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: hub ? `${station.prompt}\n\n${hub.prompt}` : station.prompt,
        },
        abortController,
      };

      let sessionId: string | null = null;
      let contextWindow = DEFAULT_CONTEXT_WINDOW;
      let contextTokens = 0;
      let costUsd = 0;
      let numTurns = 0;
      let output = "";
      let resultSubtype: string | null = null;
      let handoffRequested = false;
      /** Why the worker interrupted the session; null if the agent ended on its own. */
      let interruptedFor: "threshold" | "manual" | null = null;
      let wantHandoff: "threshold" | "manual" | null = null;
      const pendingTools = new Set<string>();
      /** Context of the first turn: system prompt, tools, CLAUDE.md — before any work. */
      let baseline: number | null = null;
      let thresholdRaised = false;
      let shownPct: number | null = null;
      let lastMessageId: string | null = null;

      const persistContext = async (): Promise<void> => {
        await db
          .update(shifts)
          .set({ contextTokens, contextWindow, numTurns })
          .where(eq(shifts.id, shiftId));
        await db
          .update(stationRuns)
          .set({ contextTokens, contextWindow })
          .where(eq(stationRuns.id, input.stationRunId));
        await invalidateShifts();
      };

      const fail = async (reason: string): Promise<never> => {
        await db
          .update(shifts)
          .set({
            status: abortController.signal.aborted ? "cancelled" : "failed",
            endReason: abortController.signal.aborted ? "cancelled" : "error",
            finishedAt: new Date(),
            costUsd,
          })
          .where(eq(shifts.id, shiftId));
        await invalidateShifts();
        throw new Error(reason);
      };

      const inputStream = createInput();
      inputStream.push(prompt);
      const session = query({
        prompt: inputStream.stream,
        options: {
          ...baseOptions,
          ...(input.maxBudgetUsd !== null ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
          ...(input.resume ? { resume: input.resume.sessionId } : {}),
          maxTurns: MAX_SHIFT_TURNS,
        },
      });

      // Heartbeat + "Handoff now" poll, independent of message flow (long tool calls).
      const checkHandoffFlag = async (): Promise<void> => {
        const [row] = await db
          .select({ handoffRequested: shifts.handoffRequested })
          .from(shifts)
          .where(eq(shifts.id, shiftId));
        if (row?.handoffRequested) handoffRequested = true;
      };
      const poll = setInterval(() => {
        ctx.heartbeat();
        checkHandoffFlag().catch(() => undefined);
      }, POLL_MS);

      const readContextWindow = async (): Promise<void> => {
        const usage = await session.getContextUsage({ detail: "summary" });
        if (usage.rawMaxTokens > 0) contextWindow = usage.rawMaxTokens;
      };

      const maybeInterrupt = async (): Promise<void> => {
        if (interruptedFor || !wantHandoff || pendingTools.size > 0) return;
        interruptedFor = wantHandoff;
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          "system",
          wantHandoff === "manual"
            ? `Handoff requested at ${contextPct(contextTokens, contextWindow)}% context`
            : `Handoff at ${contextPct(contextTokens, contextWindow)}% context`,
        );
        await db.update(shifts).set({ status: "handing_off" }).where(eq(shifts.id, shiftId));
        await invalidateShifts();
        await session.interrupt();
      };

      try {
        for await (const message of session) {
          ctx.heartbeat();
          if (message.type === "system" && message.subtype === "init") {
            sessionId = message.session_id;
            await db.update(shifts).set({ sessionId }).where(eq(shifts.id, shiftId));
            await db
              .update(stationRuns)
              .set({ sessionId, model: message.model })
              .where(eq(stationRuns.id, input.stationRunId));
            await deps.appendEvent(
              input.runId,
              input.stationRunId,
              "system",
              `Shift ${input.number} ${input.resume ? "resumed session" : "session"} ${message.session_id} · ${message.model}${effort ? ` · effort ${effort}` : ""}`,
            );
            readContextWindow().catch(() => undefined);
          } else if (message.type === "assistant" && message.parent_tool_use_id === null) {
            const usage = message.message.usage;
            const seen = usage
              ? usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0)
              : 0;
            // Synthetic messages carry zeroed usage; they say nothing about the context.
            if (seen > 0) {
              contextTokens = seen;
              // One API response streams as several messages sharing an id.
              if (message.message.id !== lastMessageId) numTurns += 1;
              lastMessageId = message.message.id;
              // Claude Code adds most of its own context on the second request, not the first.
              if (numTurns <= BASELINE_TURNS) baseline = Math.max(baseline ?? 0, contextTokens);
              await persistContext();
            }
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) {
                await deps.appendEvent(input.runId, input.stationRunId, "text", block.text);
              } else if (block.type === "tool_use") {
                pendingTools.add(block.id);
                await deps.appendEvent(
                  input.runId,
                  input.stationRunId,
                  "tool_use",
                  `${block.name} ${JSON.stringify(block.input)}`,
                );
              }
            }
            const threshold = effectiveHandoffTokens(
              station.handoffAtPct,
              contextWindow,
              baseline ?? 0,
            );
            const raisedPct = contextPct(threshold.tokens, contextWindow);
            if (threshold.raised && raisedPct !== shownPct) {
              shownPct = raisedPct;
              await db
                .update(shifts)
                .set({ handoffAtPct: raisedPct })
                .where(eq(shifts.id, shiftId));
            }
            // Announce once the baseline is final, not on the partial first turn.
            if (!thresholdRaised && threshold.raised && numTurns >= BASELINE_TURNS) {
              thresholdRaised = true;
              await deps.appendEvent(
                input.runId,
                input.stationRunId,
                "system",
                `Session starts at ${contextPct(baseline ?? 0, contextWindow)}% context, above the ${station.handoffAtPct}% handoff line; handing off at ${contextPct(threshold.tokens, contextWindow)}% instead`,
              );
            }
            if (!wantHandoff) {
              if (handoffRequested) wantHandoff = "manual";
              else if (contextTokens >= threshold.tokens) wantHandoff = "threshold";
            }
            // Interrupt only between turns (after tool results), never mid-response.
          } else if (message.type === "user" && message.parent_tool_use_id === null) {
            const content = message.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") pendingTools.delete(block.tool_use_id);
              }
            }
            if (!wantHandoff && handoffRequested) wantHandoff = "manual";
            await maybeInterrupt();
          } else if (message.type === "result") {
            costUsd = message.total_cost_usd;
            resultSubtype = message.subtype;
            output = message.subtype === "success" ? message.result : "";
            // One turn per shift: the session ends once the agent (or our interrupt) finishes it.
            inputStream.close();
          }
        }
      } catch (error) {
        clearInterval(poll);
        inputStream.close();
        // The CLI may surface our own interrupt as an error; the session is intact.
        if (!interruptedFor || abortController.signal.aborted) {
          return fail(
            `Shift ${input.number} crashed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      clearInterval(poll);

      if (!interruptedFor && resultSubtype !== "success") {
        if (resultSubtype === "error_max_budget_usd") {
          return closeShift({
            ...input,
            shiftId,
            sessionId,
            endReason: "budget",
            handoff: null,
            output: "Budget exhausted",
            costUsd,
            contextTokens,
            contextWindow,
            numTurns,
            startSha,
          });
        }
        return fail(`Shift ${input.number} ended: ${resultSubtype ?? "no result"}`);
      }

      let endReason: ShiftEndReason;
      if (interruptedFor) {
        endReason = interruptedFor;
      } else if (station.doneCommand) {
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          "tool_use",
          `$ ${station.doneCommand}`,
        );
        const check = await localRunner.runCommand(input.worktreePath, station.doneCommand, () =>
          ctx.heartbeat(),
        );
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          check.passed ? "tool_result" : "error",
          `Done check ${check.passed ? "passed" : "failed"}:\n${check.output.slice(-1_500) || "(no output)"}`,
        );
        endReason = check.passed ? "done" : (wantHandoff ?? "threshold");
      } else {
        endReason = "done";
      }

      let handoff: Handoff | null = null;
      if (endReason !== "done") {
        await db.update(shifts).set({ status: "handing_off" }).where(eq(shifts.id, shiftId));
        await invalidateShifts();
        const pct = contextPct(contextTokens, contextWindow);
        const handoffSession = query({
          prompt: buildHandoffPrompt(
            pct,
            interruptedFor ?? (wantHandoff === "manual" ? "manual" : "unfinished"),
          ),
          options: {
            ...baseOptions,
            ...(sessionId ? { resume: sessionId } : {}),
            outputFormat: { type: "json_schema", schema: HANDOFF_JSON_SCHEMA },
            maxTurns: 25,
          },
        });
        try {
          for await (const message of handoffSession) {
            ctx.heartbeat();
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              for (const block of message.message.content) {
                if (block.type === "tool_use" && block.name !== "StructuredOutput") {
                  await deps.appendEvent(
                    input.runId,
                    input.stationRunId,
                    "tool_use",
                    `${block.name} ${JSON.stringify(block.input)}`,
                  );
                }
              }
            } else if (message.type === "result") {
              costUsd += message.total_cost_usd;
              if (message.subtype === "success") {
                const parsed = handoffSchema.safeParse(message.structured_output);
                handoff = parsed.success
                  ? parsed.data
                  : {
                      summary: message.result,
                      done: [],
                      inProgress: null,
                      nextSteps: [],
                      gotchas: [],
                      filesToRead: [],
                    };
              }
            }
          }
        } catch (error) {
          if (abortController.signal.aborted) return fail("cancelled");
          await deps.appendEvent(
            input.runId,
            input.stationRunId,
            "error",
            `Handoff turn failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        handoff ??= {
          summary: output || "The shift ended without a handoff.",
          done: [],
          inProgress: null,
          nextSteps: ["Re-read .zastava/tasks.json and continue with the first unfinished task."],
          gotchas: [],
          filesToRead: [],
        };
        await deps.appendEvent(
          input.runId,
          input.stationRunId,
          "result",
          `Handoff: ${handoff.summary}`,
        );
      }

      return closeShift({
        ...input,
        shiftId,
        sessionId,
        endReason,
        handoff,
        output,
        costUsd,
        contextTokens,
        contextWindow,
        numTurns,
        startSha,
      });
    },

    /** Parks the line until a human reviews the last handoff ("Needs you"). */
    async awaitShiftReview(input: {
      runId: string;
      workOrderId: string;
      stationRunId: string;
      shiftId: string;
      number: number;
    }): Promise<void> {
      await db
        .update(shifts)
        .set({ status: "awaiting_review" })
        .where(eq(shifts.id, input.shiftId));
      await setStatuses(input, "awaiting_approval");
      await deps.appendEvent(
        input.runId,
        input.stationRunId,
        "system",
        `Handoff from shift ${input.number} is waiting for review`,
      );
      await invalidateShifts();
      await deps.invalidateBoard();
      await deps.notifyHumans(input.workOrderId, (title) => ({
        title: `Handoff ready for review: ${title}`,
        body: `Shift ${input.number} handed off. Review it before shift ${input.number + 1} starts.`,
      }));
    },

    async resolveShiftReview(input: {
      runId: string;
      workOrderId: string;
      stationRunId: string;
      shiftId: string;
      decision: "continue" | "stop";
      handoff: Handoff | null;
    }): Promise<void> {
      await db
        .update(shifts)
        .set({ status: "done", ...(input.handoff ? { handoff: input.handoff } : {}) })
        .where(eq(shifts.id, input.shiftId));
      await setStatuses(input, "running");
      await deps.appendEvent(
        input.runId,
        input.stationRunId,
        "system",
        `Handoff review: ${input.decision === "continue" ? "continue" : "stop"}${input.handoff ? " (handoff edited)" : ""}`,
      );
      await invalidateShifts();
      await deps.invalidateBoard();
    },

    /** The loop ended for a reason only the workflow sees (stuck, max shifts, stopped). */
    async endShifts(input: {
      runId: string;
      workOrderId: string;
      stationRunId: string;
      shiftId: string;
      number: number;
      endReason: ShiftEndReason;
    }): Promise<void> {
      await db
        .update(shifts)
        .set({ endReason: input.endReason })
        .where(eq(shifts.id, input.shiftId));
      await invalidateShifts();
      if (input.endReason === "stuck") {
        await deps.notifyHumans(input.workOrderId, (title) => ({
          title: `Stuck after shift ${input.number}: ${title}`,
          body: "Two shifts in a row changed no code. Check the handoff and the goal before restarting.",
        }));
      }
    },
  };
}
