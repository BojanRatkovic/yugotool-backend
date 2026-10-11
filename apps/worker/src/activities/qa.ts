import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "@temporalio/activity";
import {
  type Effort,
  type ImageEvent,
  type Preview,
  type PreviewTestResult,
  QA_PLAN_JSON_SCHEMA,
  QA_VERDICT_JSON_SCHEMA,
  qaPlanSchema,
  type QaCheckStatus,
  type QaStation,
  type QaTheme,
  type QaVerdict,
  type QaViewport,
  qaVerdictSchema,
  type RouteMap,
  type RunEventType,
  type ServerEvent,
  runTarget,
} from "@yugotool/contracts";
import {
  type Database,
  projects,
  qaChecks,
  qaRuns,
  runs,
  stationRuns,
  workOrders,
} from "@yugotool/db";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Browser } from "playwright";
import { z } from "zod";
import {
  dropSessionFile,
  previewTestDir,
  runArtifactsDir,
  sessionFileFor,
  sessionFor,
} from "../runner/artifacts";
import { localRunner } from "../runner/local-runner";
import {
  PreviewError,
  portInUse,
  previewOrigin,
  type RunningPreview,
  startPreview,
} from "../runner/preview";
import {
  capturePage,
  chromiumPath,
  diffImages,
  initScript,
  launchBrowser,
} from "../runner/qa-capture";
import {
  buildJudgePrompt,
  buildPlannerPrompt,
  browserActionLabel,
  buildQaReport,
  judgedStatus,
  type CheckForJudge,
  mergePlan,
  newConsoleErrors,
  type PlannedScenario,
  type PlannedScreen,
  planScreens,
  qaPassed,
  slugify,
  splitVerdict,
  trimDiff,
  visualStatus,
} from "../runner/qa-logic";
import { needsDiscovery, routeSourceHash } from "../runner/route-map";
import { discoverRouteMap, runStructuredSession } from "./routes";
import { accountNote, claudeAuthFor, withClaudeAuth } from "../claude-env";
import { sandboxFor } from "../runner/sandbox";
import { placeOf } from "../runner/sign-in";

const HEARTBEAT_MS = 10_000;
/** Sidecar of a cached base screenshot. */
const baseMetaSchema = z.object({
  consoleErrors: z.array(z.string()),
  error: z.string().nullable(),
});
/** Preview output is batched into one run event per interval, not one per line. */
const LOG_FLUSH_MS = 2_000;
const MAX_LOG_EVENT_CHARS = 1_500;
const LOG_TAIL_LINES = 40;
const MAX_JUDGE_TURNS = 60;
const MAX_PLANNER_TURNS = 25;

/** Browser tools the judge gets; no evaluate/run_code/file upload/tabs. */
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_resize",
  "browser_take_screenshot",
  "browser_console_messages",
].map((tool) => `mcp__playwright__${tool}`);

export interface QaDeps {
  appendEvent(
    runId: string,
    stationRunId: string | null,
    type: RunEventType,
    message: string,
  ): Promise<void>;
  notify(event: ServerEvent): Promise<void>;
}

export interface QaResult {
  status: "passed" | "failed" | "error";
  summary: string;
  /** Markdown for the builder when status is failed. */
  report: string;
  costUsd: number;
}

/** File-safe, unique per path: readable prefix + a short hash (long paths share prefixes). */
function screenSlug(screenPath: string): string {
  return `${slugify(screenPath).slice(0, 32)}-${createHash("sha1").update(screenPath).digest("hex").slice(0, 6)}`;
}

function tail(log: string, lines = LOG_TAIL_LINES): string {
  return log.trimEnd().split("\n").slice(-lines).join("\n");
}

interface Combo {
  name: string;
  path: string;
  reason: string;
  viewport: QaViewport;
  theme: QaTheme;
  slug: string;
}

export function createQaActivities(db: Database, deps: QaDeps) {
  const appendEvent: QaDeps["appendEvent"] = (...args) => deps.appendEvent(...args);
  const notify: QaDeps["notify"] = (event) => deps.notify(event);

  async function image(runId: string, stationRunId: string, event: ImageEvent): Promise<void> {
    await appendEvent(runId, stationRunId, "image", JSON.stringify(event));
  }

  /** Batches preview output lines into run events so the activity feed shows the boot live. */
  function logStreamer(runId: string, stationRunId: string) {
    let buffer = "";
    let timer: NodeJS.Timeout | null = null;
    const flush = async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      timer = null;
      let text = buffer.trimEnd();
      buffer = "";
      // Keep whole lines: cut at the first newline inside the kept tail.
      if (text.length > MAX_LOG_EVENT_CHARS) {
        const tailText = text.slice(-MAX_LOG_EVENT_CHARS);
        text = `…\n${tailText.slice(tailText.indexOf("\n") + 1)}`;
      }
      if (text) await appendEvent(runId, stationRunId, "tool_result", text);
    };
    return {
      push(line: string): void {
        buffer += `${line}\n`;
        timer ??= setTimeout(() => void flush(), LOG_FLUSH_MS);
      },
      flush,
    };
  }

  return {
    /**
     * One QA attempt: boot base + PR previews, screenshot and diff every planned
     * screen, let a Claude session judge the changes (and click through the PR
     * preview), then persist checks and return the verdict. Previews, the browser
     * and the base worktree are always cleaned up.
     */
    async runQaStation(input: {
      runId: string;
      stationRunId: string;
      station: QaStation;
      worktreePath: string;
      baseBranch: string;
      attempt: number;
      title: string;
      description: string;
      modelOverride: string | null;
      effortOverride: Effort | null;
      previousReport: string | null;
    }): Promise<QaResult> {
      const { runId, stationRunId, station } = input;
      const ctx = Context.current();
      const abort = new AbortController();
      ctx.cancellationSignal.addEventListener("abort", () => abort.abort());
      const heartbeat = setInterval(() => ctx.heartbeat(), HEARTBEAT_MS);
      const log = (type: RunEventType, message: string) =>
        appendEvent(runId, stationRunId, type, message);

      const [row] = await db
        .select({ project: projects, runRepo: runs.repo })
        .from(runs)
        .innerJoin(workOrders, eq(workOrders.id, runs.workOrderId))
        .innerJoin(projects, eq(projects.id, workOrders.projectId))
        .where(eq(runs.id, runId))
        .then((rows) =>
          rows.map(({ project, runRepo }) => ({
            projectId: project.id,
            // A hub run's QA previews its repo (spec 0014), without a route map (per repo later).
            preview: runTarget(project, runRepo).preview,
            routeMap: project.kind === "hub" ? null : project.routeMap,
            canDiscover: project.kind !== "hub",
          })),
        );
      const preview = row?.preview ?? null;
      const projectId = row?.projectId ?? null;

      const [qaRun] = await db
        .insert(qaRuns)
        .values({ stationRunId, attempt: input.attempt })
        .returning({ id: qaRuns.id });
      if (!qaRun) throw new Error("qa run insert returned nothing");
      await notify({ type: "invalidate", collection: "qa" });

      const finishQa = async (
        status: "passed" | "failed" | "error",
        summary: string,
      ): Promise<void> => {
        await db
          .update(qaRuns)
          .set({ status, summary, finishedAt: new Date() })
          .where(eq(qaRuns.id, qaRun.id));
        await notify({ type: "invalidate", collection: "qa" });
        await notify({ type: "invalidate", collection: "runs" });
      };

      if (!preview) {
        clearInterval(heartbeat);
        const summary = "Set up preview in project settings: QA needs to know how to run the app.";
        await log("error", summary);
        await finishQa("error", summary);
        return { status: "error", summary, report: summary, costUsd: 0 };
      }

      const artifacts = runArtifactsDir(runId);
      const previews: RunningPreview[] = [];
      let browser: Browser | null = null;
      let baseWorktree: string | null = null;
      let judgeSession: string | null = null;
      let costUsd = 0;

      try {
        const baseSha = await localRunner.mergeBase(input.worktreePath, input.baseBranch);
        const prSha = await localRunner.headSha(input.worktreePath);
        const changedFiles = await localRunner.changedFiles(input.worktreePath, baseSha);
        const diffStat = await localRunner
          .diffStatAgainst(input.worktreePath, input.baseBranch)
          .catch(() => "");
        let screens: PlannedScreen[] | null = null;
        let scenarios: (PlannedScenario & { ref: string })[] = [];
        // Lines saved before the switch existed have no `planner` field: on by default.
        if ((station.planner as boolean | undefined) !== false && row) {
          const planned = await planAttempt({
            ...input,
            projectId: row.projectId,
            preview,
            routeMap: row.routeMap ?? null,
            canDiscover: row.canDiscover,
            baseSha,
            diffStat,
            signal: abort.signal,
          });
          costUsd += planned.costUsd;
          if (planned.plan) {
            screens = planned.plan.screens;
            scenarios = planned.plan.scenarios.map((s, i) => ({ ...s, ref: `s${i + 1}` }));
          }
        }
        const usedPlan = screens !== null;
        screens ??= planScreens(station, changedFiles);
        const combos: Combo[] = screens.flatMap((screen) =>
          station.viewports.flatMap((viewport) =>
            station.themes.map((theme) => ({
              ...screen,
              viewport,
              theme,
              slug: `${screenSlug(screen.path)}-${viewport}-${theme}`,
            })),
          ),
        );

        // A loop-back re-checks what failed last time first.
        const previousFailed = new Set(
          (
            await db
              .select({ path: qaChecks.path, viewport: qaChecks.viewport, theme: qaChecks.theme })
              .from(qaChecks)
              .innerJoin(qaRuns, eq(qaRuns.id, qaChecks.qaRunId))
              .where(
                and(
                  eq(qaRuns.stationRunId, stationRunId),
                  ne(qaRuns.id, qaRun.id),
                  eq(qaChecks.status, "fail"),
                ),
              )
          ).map((c) => `${c.path}|${c.viewport}|${c.theme}`),
        );
        if (previousFailed.size === 0) {
          const earlier = await db
            .select({ path: qaChecks.path, viewport: qaChecks.viewport, theme: qaChecks.theme })
            .from(qaChecks)
            .innerJoin(qaRuns, eq(qaRuns.id, qaChecks.qaRunId))
            .innerJoin(stationRuns, eq(stationRuns.id, qaRuns.stationRunId))
            .where(and(eq(stationRuns.runId, runId), eq(qaChecks.status, "fail")));
          for (const c of earlier) previousFailed.add(`${c.path}|${c.viewport}|${c.theme}`);
        }
        const ordered = combos.toSorted(
          (a, b) =>
            Number(previousFailed.has(`${b.path}|${b.viewport}|${b.theme}`)) -
            Number(previousFailed.has(`${a.path}|${a.viewport}|${a.theme}`)),
        );

        const attemptRel = path.join("qa", String(input.attempt));
        // Base screenshots depend only on the base commit: reuse them across attempts.
        const baseRel = path.join("qa", `base-${baseSha.slice(0, 12)}`);
        await mkdir(path.join(artifacts, attemptRel), { recursive: true });
        await mkdir(path.join(artifacts, baseRel), { recursive: true });
        const baseCached = combos.every(
          (c) =>
            existsSync(path.join(artifacts, baseRel, `${c.slug}.png`)) &&
            existsSync(path.join(artifacts, baseRel, `${c.slug}.json`)),
        );

        await log(
          "system",
          `QA attempt ${input.attempt}: ${screens.length} screen${screens.length === 1 ? "" : "s"} × ${station.viewports.join("/")} × ${station.themes.join("/")} · base ${baseSha.slice(0, 7)}${baseCached ? " (cached)" : ""} · ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`,
        );

        const stream = logStreamer(runId, stationRunId);
        const boot = async (label: "base" | "pr", cwd: string): Promise<RunningPreview> => {
          const started = Date.now();
          const running = await startPreview({
            cwd,
            preview,
            label,
            onLog: (line) => stream.push(line),
            onProgress: () => ctx.heartbeat(),
            signal: abort.signal,
          });
          previews.push(running);
          await stream.flush();
          await log(
            "system",
            `${label === "base" ? "Base" : "This branch"} preview ready on ${running.url} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
          );
          return running;
        };

        let prPreview: RunningPreview;
        let basePreview: RunningPreview | null = null;
        try {
          if (!baseCached) {
            baseWorktree = await localRunner.addDetachedWorktree(
              input.worktreePath,
              baseSha,
              `${runId}-qa-base`,
            );
          }
          await log(
            "tool_use",
            `$ ${preview.install ? `${preview.install} && ` : ""}${preview.start}`,
          );
          // allSettled, not all: a fast failure on one side must not leave the other
          // booting unobserved (it registers in `previews` and is stopped in finally).
          const [pr, base] = await Promise.allSettled([
            boot("pr", input.worktreePath),
            baseWorktree ? boot("base", baseWorktree) : Promise.resolve(null),
          ]);
          if (pr.status === "rejected") throw pr.reason;
          if (base.status === "rejected") throw base.reason;
          prPreview = pr.value;
          basePreview = base.value;
        } catch (error) {
          await stream.flush();
          if (error instanceof PreviewError) {
            const summary = `Preview failed: ${error.message}`;
            await log("error", `${summary}\n\n${tail(error.logs)}`);
            await log("system", "Fix the preview command in project settings → Preview.");
            await finishQa("error", summary);
            return { status: "error", summary, report: summary, costUsd };
          }
          throw error;
        }
        await db
          .update(qaRuns)
          .set({ baseSha, prSha, baseUrl: basePreview?.url ?? null, prUrl: prPreview.url })
          .where(eq(qaRuns.id, qaRun.id));

        // The saved sign-in, moved to each preview's ports (localStorage is per origin).
        const baseSession =
          basePreview && projectId ? await sessionFor(projectId, placeOf(basePreview)) : null;
        const prSession = projectId ? await sessionFor(projectId, placeOf(prPreview)) : null;

        // ── Capture + diff (deterministic) ──
        browser = await launchBrowser((message) => void log("system", message));
        const consoleByPath = new Map<string, { base: string[]; pr: string[] }>();
        let position = 0;
        let unchanged = 0;
        for (const combo of ordered) {
          if (abort.signal.aborted) throw new Error("cancelled");
          ctx.heartbeat();
          const baseFile = path.join(artifacts, baseRel, `${combo.slug}.png`);
          const baseMeta = path.join(artifacts, baseRel, `${combo.slug}.json`);
          let baseErrors: string[] = [];
          let baseError: string | null = null;
          if (basePreview) {
            const shot = await capturePage({
              browser,
              origin: basePreview.url,
              preview,
              ports: basePreview,
              path: combo.path,
              viewport: combo.viewport,
              theme: combo.theme,
              file: baseFile,
              session: baseSession,
            });
            baseErrors = shot.consoleErrors;
            baseError = shot.error;
            await writeFile(
              baseMeta,
              JSON.stringify({ consoleErrors: baseErrors, error: baseError }),
            );
          } else {
            const meta = baseMetaSchema.parse(JSON.parse(await readFile(baseMeta, "utf8")));
            baseErrors = meta.consoleErrors;
            baseError = meta.error;
          }
          const prRel = path.join(attemptRel, `${combo.slug}-pr.png`);
          const diffRel = path.join(attemptRel, `${combo.slug}-diff.png`);
          const prShot = await capturePage({
            browser,
            origin: prPreview.url,
            preview,
            ports: prPreview,
            path: combo.path,
            viewport: combo.viewport,
            theme: combo.theme,
            file: path.join(artifacts, prRel),
            session: prSession,
          });
          const consoleEntry = consoleByPath.get(combo.path) ?? { base: [], pr: [] };
          consoleEntry.base.push(...baseErrors);
          consoleEntry.pr.push(...prShot.consoleErrors);
          consoleByPath.set(combo.path, consoleEntry);

          const baseRelFile = path.join(baseRel, `${combo.slug}.png`);
          let status: QaCheckStatus;
          let diffPct: number | null = null;
          let note: string | null = null;
          if (prShot.error) {
            status = "error";
            note = `Could not capture this branch: ${prShot.error}`;
          } else if (baseError) {
            // The page is new (or broken on base): nothing to diff against, the judge looks at it.
            status = "changed";
            note = `No base screenshot (${baseError}); new page?`;
          } else {
            diffPct = await diffImages(
              baseFile,
              path.join(artifacts, prRel),
              path.join(artifacts, diffRel),
            );
            status = visualStatus(diffPct, station.diffThresholdPct);
          }
          const hasBase = !baseError && existsSync(baseFile);
          const hasDiff = diffPct !== null;
          const [check] = await db
            .insert(qaChecks)
            .values({
              qaRunId: qaRun.id,
              position: position++,
              name: combo.name,
              kind: "visual",
              viewport: combo.viewport,
              theme: combo.theme,
              path: combo.path,
              reason: combo.reason,
              status,
              diffPct,
              baseShot: hasBase ? baseRelFile : null,
              prShot: prShot.error ? null : prRel,
              diffShot: hasDiff ? diffRel : null,
              note,
            })
            .returning({ id: qaChecks.id });
          if (status === "pass") {
            unchanged += 1;
            continue;
          }
          const caption = `${combo.name} · ${combo.viewport} · ${combo.theme}${diffPct !== null ? ` · ${diffPct.toFixed(2)}% changed` : ""}`;
          await log(
            "system",
            `${status === "error" ? "Could not check" : "Changed"}: ${caption}\nWhy: ${combo.reason}`,
          );
          const checkId = check?.id ?? null;
          if (hasBase)
            await image(runId, stationRunId, { file: baseRelFile, caption, role: "base", checkId });
          if (!prShot.error)
            await image(runId, stationRunId, { file: prRel, caption, role: "pr", checkId });
          if (hasDiff)
            await image(runId, stationRunId, { file: diffRel, caption, role: "diff", checkId });
        }
        for (const [checkPath, errors] of consoleByPath) {
          const fresh = newConsoleErrors(errors.base, errors.pr);
          if (fresh.length === 0) continue;
          await db.insert(qaChecks).values({
            qaRunId: qaRun.id,
            position: position++,
            name: `Console errors on ${checkPath}`,
            kind: "console",
            path: checkPath,
            status: "changed",
            note: fresh.slice(0, 10).join("\n"),
            reason: "Errors in the browser console on this branch that base does not have",
          });
          await log(
            "system",
            `New console errors on ${checkPath}:\n${fresh.slice(0, 10).join("\n")}`,
          );
        }
        if (unchanged > 0) {
          await log("system", `${unchanged} screen${unchanged === 1 ? "" : "s"} unchanged`);
        }
        await notify({ type: "invalidate", collection: "qa" });
        await notify({ type: "invalidate", collection: "runs" });
        await browser.close();
        browser = null;
        if (basePreview) await basePreview.stop();

        // ── Judge (agent) ──
        const checkRows = await db
          .select()
          .from(qaChecks)
          .where(eq(qaChecks.qaRunId, qaRun.id))
          .orderBy(asc(qaChecks.position));
        const refs = new Map(checkRows.map((c, i) => [`c${i + 1}`, c]));
        const abs = (rel: string | null) => (rel ? path.join(artifacts, rel) : null);
        const forJudge: CheckForJudge[] = [...refs].map(([ref, c]) => ({
          ref,
          name: c.name,
          kind: c.kind,
          status: c.status,
          path: c.path,
          viewport: c.viewport,
          theme: c.theme,
          diffPct: c.diffPct,
          note: c.note,
          reason: c.reason,
          baseShot: abs(c.baseShot),
          prShot: abs(c.prShot),
          diffShot: abs(c.diffShot),
        }));
        const prompt = buildJudgePrompt({
          title: input.title,
          description: input.description,
          diffStat,
          checks: forJudge,
          prUrl: prPreview.url,
          interactive: station.interactive,
          previousReport: input.previousReport,
          scenarios,
          planned: usedPlan,
          signedIn: prSession !== null,
        });
        const agentDir = path.join(artifacts, attemptRel, "agent");
        await mkdir(agentDir, { recursive: true });
        // The judge only reads, but Playwright MCP saves a screenshot given a
        // filename into its cwd — the worktree — where delivery would commit it.
        const untrackedBefore = await localRunner.untrackedFiles(input.worktreePath);
        judgeSession = projectId ? await sessionFileFor(projectId, placeOf(prPreview)) : null;
        const judged = await runJudge({
          runId,
          stationRunId,
          station,
          worktreePath: input.worktreePath,
          prompt,
          prOrigin: prPreview.url,
          // $PORT2 is where a project runs its mock API next to the app.
          allowedOrigins: [
            prPreview.url,
            previewOrigin(preview, prPreview.port2),
            `http://localhost:${prPreview.port2}`,
          ],
          initScript: initScript(preview, station.themes[0] ?? "light", prPreview),
          session: judgeSession,
          artifacts,
          agentDir,
          model: input.modelOverride ?? station.model,
          effort: input.effortOverride ?? station.effort ?? null,
          signal: abort.signal,
        });
        const strays = await localRunner
          .moveNewUntracked(input.worktreePath, untrackedBefore, agentDir)
          .catch(() => [] as string[]);
        if (strays.length) {
          await log(
            "system",
            `Moved ${strays.length} file${strays.length === 1 ? "" : "s"} the QA browser saved in the worktree out of it (kept with the QA artifacts): ${strays.join(", ")}`,
          );
        }
        costUsd += judged.costUsd;
        // The judge recorded its own cost; the station's includes planning and discovery.
        await db.update(stationRuns).set({ costUsd }).where(eq(stationRuns.id, stationRunId));
        if (!judged.verdict) {
          const summary = `QA judge returned no verdict: ${judged.output.slice(0, 300)}`;
          await finishQa("error", summary);
          return { status: "error", summary, report: summary, costUsd };
        }

        const { updates, added } = splitVerdict(judged.verdict, new Set(refs.keys()));
        for (const update of updates) {
          const target = refs.get(update.ref);
          if (!target) continue;
          await db
            .update(qaChecks)
            .set({
              status: judgedStatus(target.status, update.status),
              note: update.note,
              severity: update.severity,
            })
            .where(eq(qaChecks.id, target.id));
        }
        const scenarioByRef = new Map(scenarios.map((s) => [s.ref, s]));
        for (const extra of added) {
          const planned = extra.ref ? scenarioByRef.get(extra.ref) : undefined;
          await db.insert(qaChecks).values({
            qaRunId: qaRun.id,
            position: position++,
            name: planned?.name ?? extra.name,
            kind: "scenario",
            path: extra.path ?? planned?.path ?? null,
            status: extra.status,
            note: extra.note,
            reason: planned
              ? `${planned.reason ? `${planned.reason} ` : ""}Steps: ${planned.steps}`
              : "Found by the QA judge while clicking through the app",
            severity: extra.severity,
          });
        }
        const finalChecks = await db
          .select()
          .from(qaChecks)
          .where(eq(qaChecks.qaRunId, qaRun.id))
          .orderBy(asc(qaChecks.position));
        const passed = qaPassed(judged.verdict, finalChecks);
        const summary = judged.verdict.summary;
        await finishQa(passed ? "passed" : "failed", summary);
        const report = passed
          ? summary
          : buildQaReport(
              summary,
              finalChecks.map((c) => ({
                ...c,
                baseShot: abs(c.baseShot),
                prShot: abs(c.prShot),
                diffShot: abs(c.diffShot),
              })),
            );
        const counts = {
          pass: finalChecks.filter((c) => c.status === "pass").length,
          fail: finalChecks.filter((c) => c.status === "fail").length,
          intended: finalChecks.filter((c) => c.status === "intended").length,
        };
        await log(
          passed ? "system" : "error",
          `QA ${passed ? "passed" : "failed"} · ${counts.pass} pass · ${counts.fail} fail · ${counts.intended} intended — ${summary}`,
        );
        return { status: passed ? "passed" : "failed", summary, report, costUsd };
      } catch (error) {
        const summary = `QA crashed: ${error instanceof Error ? error.message : String(error)}`;
        await finishQa("error", summary).catch(() => undefined);
        throw error;
      } finally {
        clearInterval(heartbeat);
        await browser?.close().catch(() => undefined);
        await Promise.all(previews.map((p) => p.stop().catch(() => undefined)));
        await dropSessionFile(judgeSession);
        if (baseWorktree) await localRunner.removeWorktree(input.worktreePath, baseWorktree);
        const leaked = (
          await Promise.all(previews.map(async (p) => ((await portInUse(p.port)) ? p.port : null)))
        ).filter((p): p is number => p !== null);
        if (leaked.length)
          await log("error", `Preview ports still in use after stop: ${leaked.join(", ")}`).catch(
            () => undefined,
          );
      }
    },

    /**
     * Boots the preview once on the base branch in a throwaway worktree and
     * screenshots readyPath, so the setup can be verified before any run.
     */
    async previewTest(input: { projectId: string }): Promise<PreviewTestResult> {
      const ctx = Context.current();
      const heartbeat = setInterval(() => ctx.heartbeat(), HEARTBEAT_MS);
      const started = Date.now();
      const dir = previewTestDir(input.projectId);
      await mkdir(dir, { recursive: true });
      const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
      const finish = async (
        result: Omit<PreviewTestResult, "durationMs" | "testedAt">,
      ): Promise<PreviewTestResult> => {
        const full: PreviewTestResult = {
          ...result,
          durationMs: Date.now() - started,
          testedAt: new Date().toISOString(),
        };
        await writeFile(path.join(dir, "result.json"), JSON.stringify(full));
        await notify({ type: "invalidate", collection: "projects" });
        return full;
      };
      if (!project?.preview) {
        clearInterval(heartbeat);
        return finish({ ok: false, logs: "", error: "Preview is not set up", screenshotUrl: null });
      }
      const preview: Preview = project.preview;
      let worktree: string | null = null;
      let running: RunningPreview | null = null;
      let browser: Browser | null = null;
      try {
        worktree = await localRunner.addDetachedWorktree(
          project.repoPath,
          await localRunner.baseRef(project.repoPath, project.baseBranch),
          `preview-${input.projectId}`,
        );
        running = await startPreview({
          cwd: worktree,
          preview,
          label: "preview",
          onProgress: () => ctx.heartbeat(),
        });
        browser = await launchBrowser();
        const shot = await capturePage({
          browser,
          origin: running.url,
          preview,
          ports: running,
          path: preview.readyPath,
          viewport: "desktop",
          theme: "light",
          file: path.join(dir, "screenshot.png"),
          session: await sessionFor(input.projectId, placeOf(running)),
        });
        const logs = tail(running.logs(), 200);
        return await finish({
          ok: !shot.error,
          logs,
          error: shot.error,
          screenshotUrl: shot.error
            ? null
            : `/projects/${input.projectId}/preview/screenshot?t=${Date.now()}`,
        });
      } catch (error) {
        const logs = error instanceof PreviewError ? tail(error.logs, 200) : "";
        return await finish({
          ok: false,
          logs,
          error: error instanceof Error ? error.message : String(error),
          screenshotUrl: null,
        });
      } finally {
        clearInterval(heartbeat);
        await browser?.close().catch(() => undefined);
        await running?.stop().catch(() => undefined);
        if (worktree) await localRunner.removeWorktree(project.repoPath, worktree);
      }
    },
  };

  /**
   * Picks this attempt's screens and scenarios: makes sure the route map is
   * current (discovers it when missing or its sources changed), then asks a
   * short read-only session to map the diff onto it. Plan null = fall back.
   */
  async function planAttempt(args: {
    runId: string;
    stationRunId: string;
    station: QaStation;
    worktreePath: string;
    title: string;
    description: string;
    modelOverride: string | null;
    effortOverride: Effort | null;
    previousReport: string | null;
    projectId: string;
    preview: Preview;
    routeMap: RouteMap | null;
    /** Hub runs never discover: the map is per project, the repo per run (spec 0014). */
    canDiscover: boolean;
    baseSha: string;
    diffStat: string;
    signal: AbortSignal;
  }): Promise<{
    plan: { screens: PlannedScreen[]; scenarios: PlannedScenario[] } | null;
    costUsd: number;
  }> {
    const { runId, stationRunId, station } = args;
    const log = (type: RunEventType, message: string) =>
      appendEvent(runId, stationRunId, type, message);
    let costUsd = 0;
    let routeMap = args.routeMap;
    try {
      const currentHash = routeMap?.routerFiles.length
        ? await routeSourceHash(args.worktreePath, args.baseSha, routeMap.routerFiles)
        : null;
      if (args.canDiscover && needsDiscovery(routeMap, currentHash)) {
        await log(
          "system",
          routeMap
            ? "Route map is outdated (router files changed): rediscovering routes"
            : "No route map yet: discovering the app's routes",
        );
        const discovered = await discoverRouteMap(
          db,
          { notify },
          {
            projectId: args.projectId,
            cwd: args.worktreePath,
            hashRef: args.baseSha,
            signal: args.signal,
            events: {
              log: (type, message) =>
                type === "system" || type === "result" ? log(type, message) : Promise.resolve(),
            },
          },
        );
        costUsd += discovered.costUsd;
        if (discovered.map) {
          routeMap = discovered.map;
          await log("system", `Route map: ${routeMap.routes.length} routes`);
        } else {
          await log(
            "error",
            `Route discovery failed: ${discovered.error ?? "no routes"}. Planning from the diff alone.`,
          );
        }
      }

      const diff = trimDiff(await localRunner.diffAgainst(args.worktreePath, args.baseSha));
      const result = await runStructuredSession({
        label: "QA planner",
        auth: await claudeAuthFor({ projectId: args.projectId }),
        cwd: args.worktreePath,
        prompt: buildPlannerPrompt({
          title: args.title,
          description: args.description,
          diffStat: args.diffStat,
          diff,
          routeMap,
          pinned: station.alwaysCheck,
          baseUrlPath: args.preview.baseUrlPath,
          previousReport: args.previousReport,
        }),
        systemPrompt:
          "You plan visual QA for a code change: which screens and UI states of the running app it can affect. Read only what you need, never edit files, answer with the JSON schema.",
        schema: QA_PLAN_JSON_SCHEMA,
        model: args.modelOverride ?? station.model,
        effort: args.effortOverride ?? "low",
        maxTurns: MAX_PLANNER_TURNS,
        signal: args.signal,
        events: { log },
      });
      costUsd += result.costUsd;
      const parsed = qaPlanSchema.safeParse(result.output);
      const plan = parsed.success ? mergePlan(station, parsed.data) : null;
      if (!plan) {
        // A fallback, not a failure: QA still runs on the changed files' routes.
        await log(
          "system",
          `QA planner gave no usable screens (${result.error ?? "no visitable path"}): falling back to routes from changed files`,
        );
        return { plan: null, costUsd };
      }
      await log(
        "system",
        [
          `Plan: ${plan.screens.length} screen${plan.screens.length === 1 ? "" : "s"}${plan.scenarios.length ? `, ${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? "" : "s"}` : ""}`,
          ...plan.screens.map((s) => `- ${s.name} (${s.path}): ${s.reason}`),
          ...plan.scenarios.map((s) => `- Scenario "${s.name}" from ${s.path}: ${s.steps}`),
        ].join("\n"),
      );
      return { plan, costUsd };
    } catch (error) {
      if (args.signal.aborted) throw error;
      await log(
        "error",
        `QA planner crashed (${error instanceof Error ? error.message : String(error)}): falling back to routes from changed files`,
      );
      return { plan: null, costUsd };
    }
  }

  /**
   * The QA judge: a sandboxed Claude session in the PR worktree with read-only
   * tools, the artifact dir readable, and (when interactive) a Playwright MCP
   * browser confined to the PR preview's origin and its `$PORT2`. Its
   * screenshots become image events.
   */
  async function runJudge(args: {
    runId: string;
    stationRunId: string;
    station: QaStation;
    worktreePath: string;
    prompt: string;
    prOrigin: string;
    /** Origins the judge's browser may request: the PR preview and its `$PORT2`. */
    allowedOrigins: string[];
    /** The project's init snippet for the judge's browser; null when none. */
    initScript: string | null;
    /** Saved sign-in file (sessionFileFor) the judge's browser starts with; null when none. */
    session: string | null;
    artifacts: string;
    agentDir: string;
    model: string;
    effort: Effort | null;
    signal: AbortSignal;
  }): Promise<{ verdict: QaVerdict | null; output: string; costUsd: number }> {
    const { runId, stationRunId, station } = args;
    const ctx = Context.current();
    const abortController = new AbortController();
    args.signal.addEventListener("abort", () => abortController.abort());
    const auth = await claudeAuthFor({ runId });
    const sandboxed = withClaudeAuth(
      await sandboxFor(args.worktreePath, { readRoots: [args.artifacts] }),
      auth,
    );
    let initScriptFile: string | null = null;
    if (station.interactive && args.initScript) {
      initScriptFile = path.join(path.dirname(args.agentDir), "browser-init.js");
      await writeFile(initScriptFile, args.initScript);
    }
    const tools = ["Read", "Grep", "Glob", ...(station.interactive ? BROWSER_TOOLS : [])];
    const session = query({
      prompt: args.prompt,
      options: {
        cwd: args.worktreePath,
        model: args.model,
        ...(args.effort ? { effort: args.effort } : {}),
        ...(station.maxBudgetUsd ? { maxBudgetUsd: station.maxBudgetUsd } : {}),
        outputFormat: { type: "json_schema" as const, schema: QA_VERDICT_JSON_SCHEMA },
        tools: ["Read", "Grep", "Glob"],
        allowedTools: tools,
        additionalDirectories: [args.artifacts],
        permissionMode: "dontAsk",
        ...sandboxed,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: station.prompt },
        abortController,
        maxTurns: MAX_JUDGE_TURNS,
        ...(station.interactive
          ? {
              // The MCP server runs outside the Bash sandbox (Chromium cannot start inside it);
              // the origin allowlist and Playwright's workspace file roots confine it instead.
              mcpServers: {
                playwright: {
                  type: "stdio" as const,
                  command: "npx",
                  args: [
                    "-y",
                    "@playwright/mcp@0.0.83",
                    "--headless",
                    "--isolated",
                    "--executable-path",
                    chromiumPath(),
                    "--allowed-origins",
                    [...new Set(args.allowedOrigins)].join(";"),
                    "--output-dir",
                    args.agentDir,
                    "--viewport-size",
                    "1440x900",
                    ...(initScriptFile ? ["--init-script", initScriptFile] : []),
                    ...(args.session ? ["--storage-state", args.session] : []),
                  ],
                },
              },
            }
          : {}),
      },
    });

    const seenShots = new Set<string>();
    /** What the judge last did in the browser: the caption of the screenshot that follows. */
    let lastAction: string | null = null;
    const emitNewShots = async (): Promise<void> => {
      const files = await readdir(args.agentDir).catch(() => [] as string[]);
      for (const file of files.filter((f) => f.endsWith(".png")).toSorted()) {
        if (seenShots.has(file)) continue;
        seenShots.add(file);
        await image(runId, stationRunId, {
          file: path.relative(args.artifacts, path.join(args.agentDir, file)),
          caption: lastAction ?? "Browser screenshot",
          role: "agent",
          checkId: null,
        });
      }
    };

    let output = "";
    let costUsd = 0;
    let verdict: QaVerdict | null = null;
    let contextTokens = 0;
    for await (const message of session) {
      ctx.heartbeat();
      if (message.type === "system" && message.subtype === "init") {
        await db
          .update(stationRuns)
          .set({ sessionId: message.session_id, model: message.model, accountLabel: auth.label })
          .where(eq(stationRuns.id, stationRunId));
        const browserState = message.mcp_servers.find((s) => s.name === "playwright");
        await appendEvent(
          runId,
          stationRunId,
          "system",
          `QA judge ${message.session_id} · ${message.model}${args.effort ? ` · effort ${args.effort}` : ""}${browserState ? ` · browser ${browserState.status}` : ""}${accountNote(auth)}`,
        );
      } else if (message.type === "assistant") {
        const usage = message.message.usage;
        if (message.parent_tool_use_id === null && usage) {
          contextTokens =
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
        }
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            await appendEvent(runId, stationRunId, "text", block.text);
          } else if (block.type === "tool_use") {
            lastAction = browserActionLabel(block.name, block.input, args.prOrigin) ?? lastAction;
            await appendEvent(
              runId,
              stationRunId,
              "tool_use",
              `${block.name} ${JSON.stringify(block.input)}`,
            );
          }
        }
      } else if (message.type === "user") {
        // Screenshots land on disk when the tool returns; surface them right away.
        await emitNewShots();
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
        output =
          message.subtype === "success" ? message.result : `QA judge ended: ${message.subtype}`;
        if (message.subtype === "success" && message.structured_output !== undefined) {
          const parsed = qaVerdictSchema.safeParse(message.structured_output);
          verdict = parsed.success ? parsed.data : null;
        }
        await db
          .update(stationRuns)
          .set({
            costUsd: message.total_cost_usd,
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens,
            numTurns: message.num_turns,
            contextTokens,
            contextWindow: Object.values(message.modelUsage)[0]?.contextWindow ?? null,
          })
          .where(eq(stationRuns.id, stationRunId));
        await appendEvent(
          runId,
          stationRunId,
          "result",
          `${message.subtype} · ${message.num_turns} turns · $${message.total_cost_usd.toFixed(4)}`,
        );
      }
    }
    await emitNewShots();
    return { verdict, output, costUsd };
  }
}
