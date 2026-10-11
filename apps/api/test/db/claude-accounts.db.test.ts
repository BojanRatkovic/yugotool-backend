import {
  claudeAccounts,
  createDbClient,
  type DbClient,
  projects,
  settings,
  type Transaction as Tx,
} from "@zastava/db";
import { eq, sql } from "drizzle-orm";
import { ProjectsRepository } from "../../src/modules/projects/projects.repository";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./test-database";

const COPY_KEY = path.resolve(
  __dirname,
  "../../../../packages/db/migrations/0021_claude_accounts_api_key.sql",
);

let client: DbClient;

beforeAll(() => {
  client = createDbClient(testDatabaseUrl());
});

afterAll(async () => {
  await client.pool.end();
});

class Rollback extends Error {}

/** Runs on an empty settings/accounts pair and rolls back: other suites share the settings row. */
async function isolated(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await client.db
    .transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM settings`);
      await tx.execute(sql`DELETE FROM claude_accounts`);
      await fn(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const copyKey = async (tx: Tx) => tx.execute(sql.raw(await readFile(COPY_KEY, "utf8")));

describe("0021: the Settings API key becomes the default account (spec 0016)", () => {
  it("copies a saved key once and makes it the default", () =>
    isolated(async (tx) => {
      await tx.insert(settings).values({ id: "default", anthropicApiKey: "sk-ant-saved" });
      await copyKey(tx);
      await copyKey(tx);
      const accounts = await tx.select().from(claudeAccounts);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        kind: "api_key",
        apiKey: "sk-ant-saved",
        managed: false,
      });
      const [row] = await tx.select().from(settings).where(eq(settings.id, "default"));
      expect(row?.defaultClaudeAccountId).toBe(accounts[0]?.id);
      // The old column stays until a later migration drops it.
      expect(row?.anthropicApiKey).toBe("sk-ant-saved");
    }));

  it("leaves a plan login alone: no key, no account, no default", () =>
    isolated(async (tx) => {
      await tx.insert(settings).values({ id: "default" });
      await copyKey(tx);
      expect(await tx.select().from(claudeAccounts)).toHaveLength(0);
      const [row] = await tx.select().from(settings);
      expect(row?.defaultClaudeAccountId).toBeNull();
    }));

  it("rejects a config_dir account without a dir and a second account on one dir", () =>
    isolated(async (tx) => {
      // Each expected failure in its own savepoint, so the next statement still runs.
      const fails = (fn: (sp: Tx) => Promise<unknown>) =>
        expect(tx.transaction(async (sp) => fn(sp))).rejects.toThrow();
      await fails((sp) => sp.insert(claudeAccounts).values({ label: "x", kind: "config_dir" }));
      await tx
        .insert(claudeAccounts)
        .values({ label: "a", kind: "config_dir", configDir: "/u/.claude-a" });
      await fails((sp) =>
        sp
          .insert(claudeAccounts)
          .values({ label: "b", kind: "config_dir", configDir: "/u/.claude-a" }),
      );
      await fails((sp) => sp.insert(claudeAccounts).values({ label: "k", kind: "api_key" }));
    }));
});

describe("the account dir a project's / menu reads (spec 0016)", () => {
  it("is the project's account, else the default, else the environment's", () =>
    isolated(async (tx) => {
      const repo = new ProjectsRepository();
      const [own, fallback, key] = await tx
        .insert(claudeAccounts)
        .values([
          { label: "own", kind: "config_dir", configDir: "/u/.claude-own" },
          { label: "default", kind: "config_dir", configDir: "/u/.claude-default" },
          { label: "key", kind: "api_key", apiKey: "sk-ant-x" },
        ])
        .returning();
      const [project] = await tx
        .insert(projects)
        .values({ name: "demo", repoPath: "/tmp/demo-accounts" })
        .returning();
      const id = project!.id;
      await tx.insert(settings).values({ id: "default" });
      expect(await repo.accountConfigDir(tx, id)).toBeNull();
      await tx.update(settings).set({ defaultClaudeAccountId: fallback!.id });
      expect(await repo.accountConfigDir(tx, id)).toBe("/u/.claude-default");
      await tx.update(projects).set({ claudeAccountId: own!.id }).where(eq(projects.id, id));
      expect(await repo.accountConfigDir(tx, id)).toBe("/u/.claude-own");
      await tx.update(projects).set({ claudeAccountId: key!.id }).where(eq(projects.id, id));
      expect(await repo.accountConfigDir(tx, id)).toBeNull();
    }));
});
