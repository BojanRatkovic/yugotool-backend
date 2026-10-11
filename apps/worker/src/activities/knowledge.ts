import type { KnowledgeMount } from "@yugotool/contracts";
import { type Database, knowledgeSources, projectKnowledge, workOrders } from "@yugotool/db";
import { asc, eq } from "drizzle-orm";
import { syncKnowledgeSource } from "../runner/knowledge";
import type { ShiftDeps } from "./shifts";

type KnowledgeDeps = Pick<ShiftDeps, "appendEvent" | "notify" | "notifyHumans">;

type SourceRow = typeof knowledgeSources.$inferSelect;

const shortSha = (sha: string | null): string => (sha ? ` @ ${sha.slice(0, 7)}` : "");

export function createKnowledgeActivities(db: Database, deps: KnowledgeDeps) {
  /** Syncs one source and records the outcome on its row (sha, entry file or the error). */
  async function syncAndRecord(source: SourceRow): Promise<KnowledgeMount> {
    try {
      const mount = await syncKnowledgeSource(source);
      await db
        .update(knowledgeSources)
        .set({
          lastSyncedSha: mount.sha,
          lastSyncedAt: new Date(),
          lastEntryFile: mount.entryFile,
          lastError: null,
        })
        .where(eq(knowledgeSources.id, source.id));
      return mount;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      await db
        .update(knowledgeSources)
        .set({ lastError: message })
        .where(eq(knowledgeSources.id, source.id));
      throw error;
    } finally {
      await deps.notify({ type: "invalidate", collection: "knowledge_sources" });
    }
  }

  return {
    /** "Sync now" in Settings, and the check after a source is added or edited. */
    async syncKnowledge(input: { sourceId: string }): Promise<{ error: string | null }> {
      const [source] = await db
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, input.sourceId));
      if (!source) return { error: "Knowledge source not found." };
      try {
        await syncAndRecord(source);
        return { error: null };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },

    /**
     * Before the first planning station: syncs the project's sources and
     * returns their folders. A source that fails to sync is logged and left
     * out; it never stops the run.
     */
    async prepareKnowledge(input: {
      runId: string;
      workOrderId: string;
    }): Promise<KnowledgeMount[]> {
      const rows = await db
        .select({ source: knowledgeSources })
        .from(workOrders)
        .innerJoin(projectKnowledge, eq(projectKnowledge.projectId, workOrders.projectId))
        .innerJoin(knowledgeSources, eq(knowledgeSources.id, projectKnowledge.sourceId))
        .where(eq(workOrders.id, input.workOrderId))
        .orderBy(asc(projectKnowledge.position));
      const mounts: KnowledgeMount[] = [];
      for (const { source } of rows) {
        try {
          const mount = await syncAndRecord(source);
          mounts.push(mount);
          await deps.appendEvent(
            input.runId,
            null,
            "system",
            `Knowledge: ${mount.name}${shortSha(mount.sha)}${mount.entryFile ? ` (start: ${mount.entryFile})` : ""}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await deps.appendEvent(
            input.runId,
            null,
            "system",
            `Knowledge source "${source.name}" skipped: it failed to sync (${message.split("\n")[0]}).`,
          );
          await deps.notifyHumans(
            {
              kind: "knowledge_sync_failed",
              payload: {
                workOrderId: input.workOrderId,
                sourceId: source.id,
                name: source.name,
                error: message.slice(0, 1_000),
              },
            },
            `knowledge_sync_failed:${input.runId}:${source.id}`,
          );
        }
      }
      return mounts;
    },
  };
}
