import { Injectable } from "@nestjs/common";
import type {
  CreateKnowledgeSource,
  KnowledgeSource,
  UpdateKnowledgeSource,
} from "@zastava/contracts";
import { type Executor, knowledgeSources, projectKnowledge, projects } from "@zastava/db";
import { asc, eq, inArray } from "drizzle-orm";
import { iso } from "../../common/mappers";

type SourceRow = typeof knowledgeSources.$inferSelect;

const toSource = (row: SourceRow): KnowledgeSource => ({
  ...row,
  lastSyncedAt: iso(row.lastSyncedAt),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

@Injectable()
export class KnowledgeRepository {
  async list(db: Executor): Promise<KnowledgeSource[]> {
    const rows = await db
      .select()
      .from(knowledgeSources)
      .orderBy(asc(knowledgeSources.name), asc(knowledgeSources.createdAt));
    return rows.map(toSource);
  }

  async find(db: Executor, id: string): Promise<KnowledgeSource | null> {
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
    return row ? toSource(row) : null;
  }

  /** Idempotent on a client-generated id: a replay returns the existing row. */
  async insert(db: Executor, input: CreateKnowledgeSource): Promise<KnowledgeSource> {
    const [row] = await db
      .insert(knowledgeSources)
      .values(input)
      .onConflictDoNothing({ target: knowledgeSources.id })
      .returning();
    if (row) return toSource(row);
    const existing = input.id ? await this.find(db, input.id) : null;
    if (!existing) throw new Error("knowledge source insert returned nothing");
    return existing;
  }

  async update(
    db: Executor,
    id: string,
    patch: UpdateKnowledgeSource,
  ): Promise<KnowledgeSource | null> {
    const [row] = await db
      .update(knowledgeSources)
      .set(patch)
      .where(eq(knowledgeSources.id, id))
      .returning();
    return row ? toSource(row) : null;
  }

  async delete(db: Executor, id: string): Promise<void> {
    await db.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
  }

  /** Names of the projects that read this source. */
  async projectsUsing(db: Executor, sourceId: string): Promise<string[]> {
    const rows = await db
      .select({ name: projects.name })
      .from(projectKnowledge)
      .innerJoin(projects, eq(projects.id, projectKnowledge.projectId))
      .where(eq(projectKnowledge.sourceId, sourceId))
      .orderBy(asc(projects.name));
    return rows.map((r) => r.name);
  }

  async projectExists(db: Executor, projectId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row !== undefined;
  }

  /** Of `ids`, the ones that exist. */
  async existingIds(db: Executor, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(inArray(knowledgeSources.id, ids));
    return rows.map((r) => r.id);
  }

  async projectSourceIds(db: Executor, projectId: string): Promise<string[]> {
    const rows = await db
      .select({ sourceId: projectKnowledge.sourceId })
      .from(projectKnowledge)
      .where(eq(projectKnowledge.projectId, projectId))
      .orderBy(asc(projectKnowledge.position));
    return rows.map((r) => r.sourceId);
  }

  /** Replaces the project's sources with `sourceIds`, in that order. */
  async setProjectSources(db: Executor, projectId: string, sourceIds: string[]): Promise<void> {
    await db.delete(projectKnowledge).where(eq(projectKnowledge.projectId, projectId));
    if (sourceIds.length === 0) return;
    await db
      .insert(projectKnowledge)
      .values(sourceIds.map((sourceId, position) => ({ projectId, sourceId, position })));
  }
}
