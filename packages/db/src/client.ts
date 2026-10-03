import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/** The transaction handle Drizzle hands to `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Anything that can run a query. Repository methods take one of these so the
 * caller decides whether a statement joins an open transaction or not.
 */
export type Executor = Database | Transaction;

export interface DbClient {
  db: Database;
  pool: Pool;
}

/**
 * Creates a Drizzle client over a pg pool.
 *
 * The connection string is an argument on purpose: this package never reads
 * `process.env` — env parsing belongs to the consuming app's config layer.
 */
export function createDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
