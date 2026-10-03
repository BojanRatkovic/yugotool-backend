import { Inject, Injectable } from "@nestjs/common";
import type { Database, DbClient, Executor } from "@zastava/db";
import { DB_CLIENT } from "./database.tokens";

/**
 * The transaction boundary. Repositories never open one: they take an
 * `Executor`, so the caller decides what runs atomically.
 */
@Injectable()
export class DatabaseService {
  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  /** The pool-backed executor, for reads that need no transaction. */
  get db(): Database {
    return this.client.db;
  }

  transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.client.db.transaction(work);
  }
}
