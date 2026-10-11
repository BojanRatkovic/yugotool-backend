import { Injectable } from "@nestjs/common";
import { claudeAccounts, type Executor, projects, settings } from "@zastava/db";
import { asc, eq } from "drizzle-orm";

export type ClaudeAccountRow = typeof claudeAccounts.$inferSelect;
type NewClaudeAccount = typeof claudeAccounts.$inferInsert;

const SETTINGS_ROW = "default";

@Injectable()
export class ClaudeAccountsRepository {
  list(db: Executor): Promise<ClaudeAccountRow[]> {
    return db.select().from(claudeAccounts).orderBy(asc(claudeAccounts.createdAt));
  }

  async find(db: Executor, id: string): Promise<ClaudeAccountRow | null> {
    const [row] = await db.select().from(claudeAccounts).where(eq(claudeAccounts.id, id));
    return row ?? null;
  }

  async findByConfigDir(db: Executor, configDir: string): Promise<ClaudeAccountRow | null> {
    const [row] = await db
      .select()
      .from(claudeAccounts)
      .where(eq(claudeAccounts.configDir, configDir));
    return row ?? null;
  }

  /** Idempotent on a client-generated id: a replay returns the existing row. */
  async insert(db: Executor, values: NewClaudeAccount): Promise<ClaudeAccountRow> {
    const [row] = await db
      .insert(claudeAccounts)
      .values(values)
      .onConflictDoNothing({ target: claudeAccounts.id })
      .returning();
    if (row) return row;
    const existing = values.id ? await this.find(db, values.id) : null;
    if (!existing) throw new Error("claude account insert returned nothing");
    return existing;
  }

  async updateAuth(
    db: Executor,
    id: string,
    auth: Pick<ClaudeAccountRow, "email" | "orgName" | "subscriptionType">,
  ): Promise<void> {
    await db.update(claudeAccounts).set(auth).where(eq(claudeAccounts.id, id));
  }

  async delete(db: Executor, id: string): Promise<ClaudeAccountRow | null> {
    const [row] = await db.delete(claudeAccounts).where(eq(claudeAccounts.id, id)).returning();
    return row ?? null;
  }

  /** The project's own account, if it has one. */
  async projectAccount(db: Executor, projectId: string): Promise<ClaudeAccountRow | null> {
    const [row] = await db
      .select({ account: claudeAccounts })
      .from(projects)
      .innerJoin(claudeAccounts, eq(claudeAccounts.id, projects.claudeAccountId))
      .where(eq(projects.id, projectId));
    return row?.account ?? null;
  }

  async defaultId(db: Executor): Promise<string | null> {
    const [row] = await db
      .select({ id: settings.defaultClaudeAccountId })
      .from(settings)
      .where(eq(settings.id, SETTINGS_ROW));
    return row?.id ?? null;
  }

  /** The settings row must exist (SettingsService.get creates it). */
  async setDefault(db: Executor, id: string | null): Promise<void> {
    await db
      .update(settings)
      .set({ defaultClaudeAccountId: id })
      .where(eq(settings.id, SETTINGS_ROW));
  }
}
