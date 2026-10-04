import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { ADMIN_URL, TEST_DB, testDatabaseUrl } from "./test-database";

const MIGRATIONS = path.resolve(__dirname, "../../../../packages/db/migrations");

/**
 * Recreates `zastava_test` and applies every migration, each in its own
 * transaction (drizzle-kit's single transaction breaks on enum additions).
 * No Postgres = the run fails: a DB suite that skips silently tests nothing.
 */
export default async function setup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Postgres tests need a local server (${ADMIN_URL}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries.toSorted((a, b) => a.idx - b.idx)) {
    const sql = await readFile(path.join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
    await client.query("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  }
  await client.end();
}
