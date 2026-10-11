import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ClaudeAccountLogin } from "@zastava/contracts";
import { createDbClient, type DbClient } from "@zastava/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeAccountExistsError,
  ClaudeConfigDirInvalidError,
} from "../../src/modules/claude-accounts/claude-accounts.errors";
import { ClaudeAccountsRepository } from "../../src/modules/claude-accounts/claude-accounts.repository";
import { ClaudeAccountsService } from "../../src/modules/claude-accounts/claude-accounts.service";
import { ClaudeCli } from "../../src/modules/claude-accounts/claude-cli";
import {
  ClaudeLoginsService,
  manualLoginUrl,
} from "../../src/modules/claude-accounts/claude-logins.service";
import { ApiKeyInvalidError, SettingsService } from "../../src/modules/settings/settings.service";
import { testDatabaseUrl } from "./test-database";

const STUB = path.resolve(__dirname, "../__fixtures__/claude/claude-stub.mjs");

let client: DbClient;
let home: string;
let accounts: ClaudeAccountsService;
let logins: ClaudeLoginsService;
const realHome = process.env["HOME"];

async function signedInDir(name: string, email: string | null): Promise<string> {
  const dir = path.join(home, name);
  await mkdir(dir, { recursive: true });
  if (email)
    await writeFile(
      path.join(dir, "stub-auth.json"),
      JSON.stringify({ email, orgName: "Acme", subscriptionType: "team" }),
    );
  return dir;
}

async function settled(id: string): Promise<ClaudeAccountLogin> {
  for (let i = 0; i < 100; i++) {
    const login = logins.get(id);
    if (login.state !== "pending") return login;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("login never settled");
}

beforeAll(async () => {
  client = createDbClient(testDatabaseUrl());
  home = await mkdtemp(path.join(os.tmpdir(), "zastava-home-"));
  process.env["HOME"] = home;
  await signedInDir(".claude", "work@acme.io");
  await signedInDir(".claude-personal", "me@example.com");
  await signedInDir(".claude-empty", null);
  await writeFile(path.join(home, ".claude-notes.txt"), "not a dir");

  const database = { db: client.db, transaction: client.db.transaction.bind(client.db) };
  const events = { publish: () => Promise.resolve() };
  const settings = new SettingsService(
    { get: () => undefined } as never,
    database as never,
    events as never,
  );
  const cli = new ClaudeCli({ get: () => STUB } as never);
  const keys = {
    check: (key: string) =>
      key === "sk-ant-bad" ? Promise.reject(new ApiKeyInvalidError("rejected")) : Promise.resolve(),
  };
  accounts = new ClaudeAccountsService(
    database as never,
    new ClaudeAccountsRepository(),
    cli,
    keys,
    settings,
    events as never,
  );
  logins = new ClaudeLoginsService(accounts, cli);
});

afterAll(async () => {
  process.env["HOME"] = realHome;
  logins.onModuleDestroy();
  await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`DELETE FROM claude_accounts`);
});

describe("Claude accounts on a tmp HOME (spec 0016)", () => {
  it("discovers ~/.claude and ~/.claude-* dirs, ~/.claude read with CLAUDE_CONFIG_DIR unset", async () => {
    const found = await accounts.discover();
    expect(found.map((f) => path.basename(f.configDir))).toEqual([
      ".claude",
      ".claude-empty",
      ".claude-personal",
    ]);
    expect(found.map((f) => [f.loggedIn, f.email])).toEqual([
      [true, "work@acme.io"],
      [false, null],
      [true, "me@example.com"],
    ]);
  });

  it("adds a signed-in dir once, named by its email, and refuses a signed-out one", async () => {
    const account = await accounts.create({ kind: "config_dir", configDir: "~/.claude-personal/" });
    expect(account).toMatchObject({
      label: "me@example.com",
      configDir: path.join(home, ".claude-personal"),
      subscriptionType: "team",
      status: "signed_in",
      managed: false,
      isDefault: false,
    });
    await expect(
      accounts.create({ kind: "config_dir", configDir: path.join(home, ".claude-personal") }),
    ).rejects.toBeInstanceOf(ClaudeAccountExistsError);
    await expect(
      accounts.create({ kind: "config_dir", configDir: "~/.claude-empty" }),
    ).rejects.toBeInstanceOf(ClaudeConfigDirInvalidError);
    const found = await accounts.discover();
    expect(found.find((f) => f.configDir.endsWith(".claude-personal"))?.accountId).toBe(account.id);
  });

  it("adds the default ~/.claude dir as signed in", async () => {
    const account = await accounts.create({ kind: "config_dir", configDir: "~/.claude" });
    expect(account).toMatchObject({ email: "work@acme.io", status: "signed_in" });
  });

  it("masks API keys and marks a rejected one", async () => {
    await accounts.create({ kind: "api_key", label: "CI", apiKey: "sk-ant-api03-goodkey1234" });
    await expect(
      accounts.create({ kind: "api_key", label: "Bad", apiKey: "sk-ant-bad" }),
    ).rejects.toBeInstanceOf(ApiKeyInvalidError);
    const [key] = await accounts.list();
    expect(key).toMatchObject({ kind: "api_key", apiKeyHint: "sk-ant-api03-…1234" });
    expect(key).not.toHaveProperty("apiKey");
  });

  it("makes an account the default, and removing it falls back to the environment", async () => {
    const account = await accounts.create({ kind: "config_dir", configDir: "~/.claude-personal" });
    await accounts.setDefault(account.id);
    expect((await accounts.list())[0]?.isDefault).toBe(true);
    await accounts.remove(account.id);
    expect(await accounts.list()).toEqual([]);
    const [row] = (
      await client.db.execute<{ id: string | null }>(
        sql`SELECT default_claude_account_id AS id FROM settings`,
      )
    ).rows;
    expect(row?.id).toBeNull();
    // Not ZASTAVA's dir: never touched.
    expect(existsSync(path.join(home, ".claude-personal", "stub-auth.json"))).toBe(true);
  });

  it("signs in a new account with a pasted code, and removing it deletes its dir", async () => {
    const started = await logins.start({ label: "Side project", email: "side@example.com" });
    expect(started).toMatchObject({ state: "pending", accountId: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(logins.get(started.id).url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&state=stub",
    );
    logins.submitCode(started.id, "good");
    const done = await settled(started.id);
    expect(done.state).toBe("done");
    const [account] = await accounts.list();
    expect(account).toMatchObject({
      id: done.accountId,
      label: "Side project",
      email: "side@example.com",
      managed: true,
      status: "signed_in",
    });
    expect(account?.configDir?.startsWith(path.join(home, ".zastava", "accounts"))).toBe(true);
    await accounts.remove(account!.id);
    expect(existsSync(account!.configDir!)).toBe(false);
  });

  it("fails on a bad code and on cancel, leaving no dir behind", async () => {
    const bad = await logins.start({ label: "Nope" });
    logins.submitCode(bad.id, "wrong");
    expect(await settled(bad.id)).toMatchObject({
      state: "failed",
      error: "Login failed: Request failed with status code 400",
    });
    const cancelled = await logins.start({ label: "Later" });
    logins.cancel(cancelled.id);
    expect(logins.get(cancelled.id)).toMatchObject({ state: "failed", error: "Cancelled." });
    await new Promise((r) => setTimeout(r, 100));
    const { readdir } = await import("node:fs/promises");
    const left = await readdir(path.join(home, ".zastava", "accounts")).catch(() => []);
    expect(left).toEqual([]);
    expect(await accounts.list()).toEqual([]);
  });

  it("signs an existing account in again without adding one", async () => {
    const account = await accounts.create({ kind: "config_dir", configDir: "~/.claude-personal" });
    const again = await logins.start({ accountId: account.id, email: "me2@example.com" });
    logins.submitCode(again.id, "good");
    expect(await settled(again.id)).toMatchObject({ state: "done", accountId: account.id });
    const list = await accounts.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: "me2@example.com", label: "me@example.com" });
  });
});

describe("manualLoginUrl", () => {
  it("finds the link inside the OSC 8 hyperlink, and nothing before it is printed", () => {
    expect(manualLoginUrl("Opening browser to sign in…\n")).toBeNull();
    expect(
      manualLoginUrl(
        "visit: \u001b]8;;https://claude.com/cai/oauth/authorize?a=1&b=2\u0007https://claude.com/cai/oauth/authorize?a=1&b=2\u001b]8;;\u0007\n",
      ),
    ).toBe("https://claude.com/cai/oauth/authorize?a=1&b=2");
  });
});
