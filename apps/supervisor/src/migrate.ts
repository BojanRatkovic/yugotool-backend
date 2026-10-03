import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import { z } from "zod";

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
});

export interface Migration {
  tag: string;
  /** Journal timestamp; drizzle stores it as `created_at` and compares on it. */
  when: number;
  hash: string;
  statements: string[];
}

/** Reads drizzle-kit's journal and SQL files (same hash drizzle uses: sha256 of the file). */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(path.join(dir, "meta", "_journal.json"), "utf8")),
  );
  return Promise.all(
    journal.entries
      .toSorted((a, b) => a.idx - b.idx)
      .map(async (entry) => {
        const sql = await readFile(path.join(dir, `${entry.tag}.sql`), "utf8");
        return {
          tag: entry.tag,
          when: entry.when,
          hash: createHash("sha256").update(sql).digest("hex"),
          statements: sql
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }),
  );
}

/** Migrations newer than the last applied one, the rule drizzle's migrator uses. */
export function pending(all: Migration[], lastAppliedAt: number | null): Migration[] {
  return lastAppliedAt === null ? all : all.filter((m) => m.when > lastAppliedAt);
}

/**
 * Applies pending migrations, **each in its own transaction**. drizzle-kit
 * runs them all in one, which breaks on a fresh database: a new enum value
 * cannot be used in the transaction that added it. Bookkeeping goes to
 * drizzle's own table, so `pnpm db:migrate` stays interchangeable.
 */
export async function migrate(client: Client, dir: string): Promise<string[]> {
  await client.query(`create schema if not exists drizzle`);
  await client.query(
    `create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
  );
  const { rows } = await client.query<{ created_at: string | null }>(
    `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  const last = rows[0]?.created_at;
  const todo = pending(await readMigrations(dir), last ? Number(last) : null);
  for (const migration of todo) {
    await client.query("begin");
    try {
      for (const statement of migration.statements) await client.query(statement);
      await client.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.when],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw new Error(
        `migration ${migration.tag} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return todo.map((m) => m.tag);
}
