import { rm } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type CreateKnowledgeSource,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type ProjectKnowledge,
  TASK_QUEUE,
  type UpdateKnowledgeSource,
} from "@yugotool/contracts";
import type { Client } from "@temporalio/client";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import {
  KnowledgeLocationInvalidError,
  KnowledgeProjectNotFoundError,
  KnowledgeSourceInUseError,
  KnowledgeSourceNotFoundError,
} from "./knowledge.errors";
import { locationProblem } from "./knowledge.location";
import { KnowledgeRepository } from "./knowledge.repository";
import { yugotoolHome } from "../../core/config/home";

/** Where the worker keeps snapshots (runner/knowledge.ts). */
const KNOWLEDGE_ROOT = path.join(yugotoolHome(), "knowledge");

/** Settings → Knowledge (the library) and each project's choice from it. Spec 0007. */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: KnowledgeRepository,
    private readonly events: EventsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  list(): Promise<KnowledgeSource[]> {
    return this.repository.list(this.database.db);
  }

  /** Adds a source and syncs it once, so the form shows at once whether it works. */
  async create(input: CreateKnowledgeSource): Promise<KnowledgeSource> {
    this.assertLocation(input.kind, input.location);
    const source = await this.repository.insert(this.database.db, input);
    await this.notify();
    return this.sync(source.id);
  }

  /** Edits a source; a changed location, kind, branch or excludes syncs it again. */
  async update(id: string, patch: UpdateKnowledgeSource): Promise<KnowledgeSource> {
    const current = await this.repository.find(this.database.db, id);
    if (!current) throw new KnowledgeSourceNotFoundError(`knowledge source ${id} not found`);
    const kind = patch.kind ?? current.kind;
    const location = patch.location ?? current.location;
    if (patch.kind !== undefined || patch.location !== undefined)
      this.assertLocation(kind, location);
    const updated = await this.repository.update(this.database.db, id, patch);
    if (!updated) throw new KnowledgeSourceNotFoundError(`knowledge source ${id} not found`);
    await this.notify();
    const resync = ["kind", "location", "branch", "excludes", "entryFile"].some(
      (key) => key in patch,
    );
    return resync ? this.sync(id) : updated;
  }

  /** Refused while a project reads it: detach it there first. Removes its snapshots. */
  async delete(id: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const source = await this.repository.find(tx, id);
      if (!source) throw new KnowledgeSourceNotFoundError(`knowledge source ${id} not found`);
      const using = await this.repository.projectsUsing(tx, id);
      if (using.length > 0) {
        throw new KnowledgeSourceInUseError(
          `${source.name} is used by ${using.join(", ")}. Remove it from ${using.length === 1 ? "that project" : "those projects"} first.`,
          { projects: using },
        );
      }
      await this.repository.delete(tx, id);
    });
    await rm(path.join(KNOWLEDGE_ROOT, id), { recursive: true, force: true }).catch(
      (error: unknown) => this.logger.warn({ err: error }, "knowledge snapshot cleanup failed"),
    );
    await this.notify();
  }

  /**
   * Syncs in the worker (clone/fetch, snapshot) and returns the source with
   * the outcome: lastSyncedSha/At or lastError. One sync per source at a time.
   */
  async sync(id: string): Promise<KnowledgeSource> {
    await this.temporal.workflow.execute("syncKnowledge", {
      taskQueue: TASK_QUEUE,
      workflowId: `knowledge-sync-${id}`,
      workflowIdConflictPolicy: "USE_EXISTING",
      args: [{ sourceId: id }],
    });
    const source = await this.repository.find(this.database.db, id);
    if (!source) throw new KnowledgeSourceNotFoundError(`knowledge source ${id} not found`);
    return source;
  }

  async projectKnowledge(projectId: string): Promise<ProjectKnowledge> {
    if (!(await this.repository.projectExists(this.database.db, projectId))) {
      throw new KnowledgeProjectNotFoundError(`project ${projectId} not found`);
    }
    return { sourceIds: await this.repository.projectSourceIds(this.database.db, projectId) };
  }

  /** Sets which sources the project's planning stations read, in order. */
  async setProjectKnowledge(projectId: string, input: ProjectKnowledge): Promise<ProjectKnowledge> {
    const sourceIds = [...new Set(input.sourceIds)];
    await this.database.transaction(async (tx) => {
      if (!(await this.repository.projectExists(tx, projectId))) {
        throw new KnowledgeProjectNotFoundError(`project ${projectId} not found`);
      }
      const existing = new Set(await this.repository.existingIds(tx, sourceIds));
      const missing = sourceIds.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        throw new KnowledgeSourceNotFoundError("Some knowledge sources no longer exist.", {
          missing,
        });
      }
      await this.repository.setProjectSources(tx, projectId, sourceIds);
    });
    await this.notify();
    return { sourceIds };
  }

  private assertLocation(kind: KnowledgeSourceKind, location: string): void {
    const problem = locationProblem(kind, location);
    if (problem) throw new KnowledgeLocationInvalidError(problem);
  }

  private notify(): Promise<void> {
    return this.events.publish({ type: "invalidate", collection: "knowledge_sources" });
  }
}
