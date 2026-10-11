import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  type FinishSignIn,
  type PreviewSession,
  type PreviewSessionStatus,
  previewSignInSchema,
  storageStateSchema,
  summarizeStorageState,
  TASK_QUEUE,
} from "@yugotool/contracts";
import {
  previewSessionFile,
  previewSignInFile,
  previewSignInFinishFile,
} from "../../core/artifacts/artifacts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import {
  PreviewNotConfiguredError,
  PreviewSignInNotRunningError,
  PreviewSignInRunningError,
  ProjectNotFoundError,
} from "./project.errors";
import { ProjectsRepository } from "./projects.repository";

/**
 * "Sign in once" for a project's preview. The worker owns the browser and the
 * preview process; the API starts the workflow, relays Done/Cancel through a
 * file next to the session, and reads back the saved session's summary.
 */
@Injectable()
export class PreviewSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProjectsRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  async status(projectId: string): Promise<PreviewSessionStatus> {
    await this.project(projectId);
    return { session: await readSession(projectId), signIn: await this.signIn(projectId) };
  }

  /** Boots the preview and opens a browser window on this Mac; returns at once. */
  async start(projectId: string): Promise<PreviewSessionStatus> {
    const project = await this.project(projectId);
    if (!project.preview) throw new PreviewNotConfiguredError("set up the preview first");
    try {
      await this.temporal.workflow.start("previewSignIn", {
        taskQueue: TASK_QUEUE,
        workflowId: signInWorkflowId(projectId),
        args: [{ projectId }],
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError)
        throw new PreviewSignInRunningError("a sign-in is already open for this project");
      throw error;
    }
    // The worker writes its first state in a moment; report "starting" until then.
    await writeFile(
      previewSignInFile(projectId),
      JSON.stringify({
        status: "starting",
        url: null,
        error: null,
        logs: "",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }),
    ).catch(() => undefined);
    return this.status(projectId);
  }

  /** Done (save what the browser holds) or Cancel, from the app instead of the window. */
  async finish(projectId: string, body: FinishSignIn): Promise<PreviewSessionStatus> {
    await this.project(projectId);
    const current = await this.signIn(projectId);
    if (current?.status !== "starting" && current?.status !== "waiting")
      throw new PreviewSignInNotRunningError("no sign-in is open for this project");
    if (current.status === "starting") {
      // Still installing / booting: there is no browser yet, so stop the workflow.
      await this.temporal.workflow
        .getHandle(signInWorkflowId(projectId))
        .cancel()
        .catch(() => undefined);
    }
    await writeFile(previewSignInFinishFile(projectId), JSON.stringify(body));
    return this.status(projectId);
  }

  /** Forgets the saved session; browsers on the preview start signed out again. */
  async forget(projectId: string): Promise<void> {
    await this.project(projectId);
    await rm(previewSessionFile(projectId), { force: true });
    await this.events.publish({ type: "invalidate", collection: "projects" });
  }

  private async project(projectId: string) {
    const project = await this.repository.find(this.database.db, projectId);
    if (!project) throw new ProjectNotFoundError(`project ${projectId} not found`);
    return project;
  }

  private async signIn(projectId: string) {
    const raw = await readFile(previewSignInFile(projectId), "utf8").catch(() => null);
    const parsed = raw ? previewSignInSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : null;
  }
}

const signInWorkflowId = (projectId: string): string => `preview-sign-in-${projectId}`;

async function readSession(projectId: string): Promise<PreviewSession | null> {
  const file = previewSessionFile(projectId);
  const [raw, info] = await Promise.all([
    readFile(file, "utf8").catch(() => null),
    stat(file).catch(() => null),
  ]);
  if (!raw || !info) return null;
  try {
    const state = storageStateSchema.safeParse(JSON.parse(raw));
    if (!state.success) return null;
    return { savedAt: info.mtime.toISOString(), ...summarizeStorageState(state.data) };
  } catch {
    return null;
  }
}
