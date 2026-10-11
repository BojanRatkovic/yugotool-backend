import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Context } from "@temporalio/activity";
import { type PreviewSignIn, type ServerEvent, finishSignInSchema } from "@yugotool/contracts";
import { type Database, projects } from "@yugotool/db";
import { eq } from "drizzle-orm";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  previewSessionCopiesDir,
  previewSessionFile,
  previewSignInFile,
  previewSignInFinishFile,
  previewTestDir,
  sessionFor,
} from "../runner/artifacts";
import { localRunner } from "../runner/local-runner";
import { PreviewError, previewUrl, type RunningPreview, startPreview } from "../runner/preview";
import { launchVisibleBrowser } from "../runner/qa-capture";
import {
  BrowserTrace,
  hasState,
  placeOf,
  redactUrl,
  type SavedSession,
  type StorageState,
} from "../runner/sign-in";

const HEARTBEAT_MS = 10_000;
const POLL_MS = 1_000;
/** A sign-in nobody finishes ends on its own. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const LOG_TAIL_LINES = 120;

export interface PreviewSignInDeps {
  notify(event: ServerEvent): Promise<void>;
}

/**
 * "Sign in once": boots the preview on the base branch, opens a visible
 * browser on it and lets the user sign in however the app wants. What the
 * browser holds (cookies, localStorage) is saved for the project when the
 * window is closed or Done is clicked; every later browser on the preview
 * (Test preview, QA captures, the judge) starts with it.
 */
export function createPreviewSignInActivities(db: Database, deps: PreviewSignInDeps) {
  return {
    async previewSignIn(input: { projectId: string }): Promise<PreviewSignIn> {
      const ctx = Context.current();
      const heartbeat = setInterval(() => ctx.heartbeat(), HEARTBEAT_MS);
      const { projectId } = input;
      await mkdir(previewTestDir(projectId), { recursive: true });
      await rm(previewSignInFinishFile(projectId), { force: true });

      let state: PreviewSignIn = {
        status: "starting",
        url: null,
        error: null,
        logs: "",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      const save = async (patch: Partial<PreviewSignIn>): Promise<PreviewSignIn> => {
        state = { ...state, ...patch };
        await writeFile(previewSignInFile(projectId), JSON.stringify(state));
        await deps.notify({ type: "invalidate", collection: "projects" });
        return state;
      };
      const end = (patch: Partial<PreviewSignIn>): Promise<PreviewSignIn> =>
        save({ ...patch, finishedAt: new Date().toISOString() });
      await save({});

      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!project?.preview) {
        clearInterval(heartbeat);
        return end({ status: "failed", error: "Preview is not set up" });
      }
      const preview = project.preview;
      let worktree: string | null = null;
      let running: RunningPreview | null = null;
      let browser: Browser | null = null;
      try {
        worktree = await localRunner.addDetachedWorktree(
          project.repoPath,
          await localRunner.baseRef(project.repoPath, project.baseBranch),
          `sign-in-${projectId}`,
        );
        running = await startPreview({
          cwd: worktree,
          preview,
          label: "sign-in",
          onProgress: () => ctx.heartbeat(),
          signal: ctx.cancellationSignal,
        });
        browser = await launchVisibleBrowser();
        // Start from the saved session, so "Sign in again" can refresh it.
        const existing = await sessionFor(projectId, placeOf(running));
        const context = await browser.newContext({
          viewport: null,
          ...(existing ? { storageState: existing } : {}),
        });
        const url = previewUrl(running.url, preview, preview.readyPath);
        const trace = new BrowserTrace();
        traceContext(context, trace);
        const previewLogs = tail(running.logs());
        const logs = (): string => `${previewLogs}\n\n── Sign-in window ──\n${trace.text()}`;
        const page = await context.newPage();
        await page.goto(url).catch(() => undefined);
        await page.bringToFront().catch(() => undefined);
        await save({ status: "waiting", url, logs: logs() });
        let shown = trace.version;
        const onTick = async (): Promise<void> => {
          if (trace.version === shown) return;
          shown = trace.version;
          await save({ logs: logs() });
        };

        const outcome = await waitForUser(
          browser,
          context,
          projectId,
          ctx.cancellationSignal,
          onTick,
        );
        if (outcome.action === "cancel") return await end({ status: "cancelled", logs: logs() });
        if (!outcome.state || !hasState(outcome.state))
          return await end({
            status: "failed",
            error: "The browser held no cookies or storage, so there was nothing to save.",
            logs: logs(),
          });
        // Where it ran, so later previews on other ports can move it (retargetSession).
        const saved: SavedSession = { ...outcome.state, signedInOn: placeOf(running) };
        await writeFile(previewSessionFile(projectId), JSON.stringify(saved), { mode: 0o600 });
        await rm(previewSessionCopiesDir(projectId), { recursive: true, force: true });
        return await end({
          status: "saved",
          logs: logs(),
          error: trace.loopSuspected()
            ? "Saved, but the window kept redirecting (see the sign-in log): the app may not accept this session."
            : null,
        });
      } catch (error) {
        return await end({
          status: ctx.cancellationSignal.aborted ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
          logs: error instanceof PreviewError ? tail(error.logs) : state.logs,
        });
      } finally {
        clearInterval(heartbeat);
        await browser?.close().catch(() => undefined);
        await running?.stop().catch(() => undefined);
        if (worktree) await localRunner.removeWorktree(project.repoPath, worktree);
        await rm(previewSignInFinishFile(projectId), { force: true });
      }
    },
  };
}

/**
 * Waits for Done / Cancel from the app, the window being closed (= done) or
 * the timeout. The storage state is snapshotted every second, because once
 * the user closes the window it can no longer be read.
 */
async function waitForUser(
  browser: Browser,
  context: BrowserContext,
  projectId: string,
  cancelled: AbortSignal,
  onTick: () => Promise<void>,
): Promise<{ action: "save" | "cancel"; state: StorageState | null }> {
  let snapshot: StorageState | null = null;
  let disconnected = false;
  browser.on("disconnected", () => {
    disconnected = true;
  });
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  for (;;) {
    if (cancelled.aborted) return { action: "cancel", state: null };
    const requested = await finishRequest(projectId);
    if (requested === "cancel") return { action: "cancel", state: null };
    if (!disconnected) {
      snapshot = await context.storageState().catch(() => snapshot);
    }
    if (requested === "save") return { action: "save", state: snapshot };
    if (disconnected || context.pages().length === 0) return { action: "save", state: snapshot };
    if (Date.now() > deadline) throw new Error("Sign-in timed out after 15 minutes.");
    await onTick().catch(() => undefined);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Logs main-frame navigations, failed document/API responses and console errors of every page. */
function traceContext(context: BrowserContext, trace: BrowserTrace): void {
  const watch = (page: Page): void => {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) trace.navigated(frame.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") trace.add(`console: ${message.text().slice(0, 200)}`);
    });
  };
  context.on("page", watch);
  context.on("response", (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ["document", "xhr", "fetch"].includes(type))
      trace.add(`${response.status()} ${response.request().method()} ${redactUrl(response.url())}`);
  });
  context.on("requestfailed", (request) => {
    const type = request.resourceType();
    if (["document", "xhr", "fetch"].includes(type))
      trace.add(
        `failed ${request.method()} ${redactUrl(request.url())} (${request.failure()?.errorText ?? "error"})`,
      );
  });
}

async function finishRequest(projectId: string): Promise<"save" | "cancel" | null> {
  const raw = await readFile(previewSignInFinishFile(projectId), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = finishSignInSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.action : null;
  } catch {
    return null;
  }
}

function tail(log: string): string {
  return log.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
}
