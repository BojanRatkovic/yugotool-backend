import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import type {
  ClaudeAccount,
  ClaudeAccountStatus,
  CreateClaudeAccount,
  DiscoveredAccount,
} from "@zastava/contracts";
import { iso } from "../../common/mappers";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import {
  ApiKeyInvalidError,
  checkApiKey,
  maskApiKey,
  SettingsService,
} from "../settings/settings.service";
import {
  ClaudeAccountExistsError,
  ClaudeAccountNotFoundError,
  ClaudeConfigDirInvalidError,
} from "./claude-accounts.errors";
import { type ClaudeAccountRow, ClaudeAccountsRepository } from "./claude-accounts.repository";
import { type ClaudeAuthStatus, ClaudeCli } from "./claude-cli";

/** A rejected key stays rejected for a while; no need to ask Anthropic on every list. */
const KEY_CHECK_CACHE_MS = 5 * 60_000;

/** Asks Anthropic whether an API key works (swapped for a fake in tests). */
@Injectable()
export class ApiKeyCheck {
  check(key: string): Promise<void> {
    return checkApiKey(key);
  }
}

/** Settings → Claude accounts (spec 0016): logins and API keys sessions run on. */
@Injectable()
export class ClaudeAccountsService {
  private readonly keyChecks = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ClaudeAccountsRepository,
    private readonly cli: ClaudeCli,
    private readonly keys: ApiKeyCheck,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
  ) {}

  /** Every account with a live status; a config dir's email and plan are refreshed on the way. */
  async list(): Promise<ClaudeAccount[]> {
    const db = this.database.db;
    const [rows, defaultId] = await Promise.all([
      this.repository.list(db),
      this.repository.defaultId(db),
    ]);
    return Promise.all(
      rows.map(async (row) => {
        const { status, auth } = await this.statusOf(row);
        if (auth?.loggedIn && authChanged(row, auth)) {
          await this.repository.updateAuth(db, row.id, auth);
          row = {
            ...row,
            email: auth.email,
            orgName: auth.orgName,
            subscriptionType: auth.subscriptionType,
          };
        }
        return toAccount(row, row.id === defaultId, status);
      }),
    );
  }

  async exists(id: string): Promise<boolean> {
    return (await this.repository.find(this.database.db, id)) !== null;
  }

  /** `~/.claude` and every `~/.claude-*` dir, read with `claude auth status`. */
  async discover(): Promise<DiscoveredAccount[]> {
    const home = this.cli.home();
    const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && /^\.claude(-.+)?$/.test(e.name))
      .map((e) => path.join(home, e.name))
      .toSorted((a, b) =>
        a.endsWith("/.claude") ? -1 : b.endsWith("/.claude") ? 1 : a.localeCompare(b),
      );
    const added = new Map(
      (await this.repository.list(this.database.db))
        .filter((row) => row.configDir)
        .map((row) => [row.configDir, row.id]),
    );
    return Promise.all(
      dirs.map(async (configDir) => {
        const auth = await this.cli.status(configDir);
        return {
          configDir,
          loggedIn: auth?.loggedIn ?? false,
          email: auth?.email ?? null,
          orgName: auth?.orgName ?? null,
          subscriptionType: auth?.subscriptionType ?? null,
          accountId: added.get(configDir) ?? null,
        };
      }),
    );
  }

  /** Adds a signed-in config dir or an API key (checked with Anthropic first). */
  async create(input: CreateClaudeAccount): Promise<ClaudeAccount> {
    const db = this.database.db;
    if (input.id) {
      const replay = await this.repository.find(db, input.id);
      if (replay) return this.one(replay.id);
    }
    let row: ClaudeAccountRow;
    if (input.kind === "api_key" && input.apiKey) {
      await this.keys.check(input.apiKey);
      row = await this.repository.insert(db, {
        id: input.id,
        label: input.label ?? "API key",
        kind: "api_key",
        apiKey: input.apiKey,
      });
    } else {
      const configDir = this.resolveDir(input.configDir ?? "");
      if (await this.repository.findByConfigDir(db, configDir))
        throw new ClaudeAccountExistsError(`${configDir} is already added`);
      if (!(await isDirectory(configDir)))
        throw new ClaudeConfigDirInvalidError(`${configDir} is not a folder`);
      const auth = await this.cli.status(configDir);
      if (!auth?.loggedIn)
        throw new ClaudeConfigDirInvalidError(
          `claude is not signed in at ${configDir}. Sign in there first, or add the account with Sign in.`,
        );
      row = await this.repository.insert(db, {
        id: input.id,
        label: input.label ?? auth.email ?? path.basename(configDir),
        kind: "config_dir",
        configDir,
        email: auth.email,
        orgName: auth.orgName,
        subscriptionType: auth.subscriptionType,
      });
    }
    await this.notify();
    return this.one(row.id);
  }

  /** Called by a finished login: a new managed dir, or fresh details for an existing account. */
  async saveLogin(
    accountId: string | null,
    values: { id?: string; label: string; configDir: string },
    auth: ClaudeAuthStatus,
  ): Promise<string> {
    const db = this.database.db;
    const fields = {
      email: auth.email,
      orgName: auth.orgName,
      subscriptionType: auth.subscriptionType,
    };
    if (accountId) {
      await this.repository.updateAuth(db, accountId, fields);
    } else {
      accountId = (
        await this.repository.insert(db, {
          ...values,
          kind: "config_dir",
          managed: true,
          ...fields,
        })
      ).id;
    }
    await this.notify();
    return accountId;
  }

  async find(id: string): Promise<ClaudeAccountRow> {
    const row = await this.repository.find(this.database.db, id);
    if (!row) throw new ClaudeAccountNotFoundError(`Claude account ${id} not found`);
    return row;
  }

  /**
   * Removes the account; its projects and the default fall back (FKs set null).
   * A dir ZASTAVA created is signed out and deleted; any other dir is never touched.
   */
  async remove(id: string): Promise<void> {
    const row = await this.repository.delete(this.database.db, id);
    if (!row) throw new ClaudeAccountNotFoundError(`Claude account ${id} not found`);
    if (row.managed && row.configDir && this.isManagedDir(row.configDir)) {
      await this.cli.logout(row.configDir);
      await rm(row.configDir, { recursive: true, force: true });
    }
    await this.notify();
    await this.events.publish({ type: "invalidate", collection: "projects" });
  }

  async setDefault(accountId: string | null): Promise<void> {
    if (accountId) await this.find(accountId);
    await this.settings.get();
    await this.repository.setDefault(this.database.db, accountId);
    await this.notify();
    await this.events.publish({ type: "invalidate", collection: "settings" });
    await this.events.publish({ type: "invalidate", collection: "dispatcher" });
  }

  /** A fresh dir for a new login: `~/.zastava/accounts/<slug>-<random>`. */
  async createManagedDir(label: string): Promise<string> {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const dir = path.join(
      this.accountsRoot(),
      `${slug || "account"}-${crypto.randomUUID().slice(0, 8)}`,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  isManagedDir(dir: string): boolean {
    return path.resolve(dir).startsWith(this.accountsRoot() + path.sep);
  }

  private accountsRoot(): string {
    return path.join(this.cli.home(), ".zastava", "accounts");
  }

  private async one(id: string): Promise<ClaudeAccount> {
    const account = (await this.list()).find((a) => a.id === id);
    if (!account) throw new ClaudeAccountNotFoundError(`Claude account ${id} not found`);
    return account;
  }

  private async statusOf(
    row: ClaudeAccountRow,
  ): Promise<{ status: ClaudeAccountStatus; auth: ClaudeAuthStatus | null }> {
    if (row.kind === "api_key")
      return { status: await this.keyStatus(row.apiKey ?? ""), auth: null };
    const auth = row.configDir ? await this.cli.status(row.configDir) : null;
    return { status: !auth ? "unknown" : auth.loggedIn ? "signed_in" : "signed_out", auth };
  }

  private async keyStatus(key: string): Promise<ClaudeAccountStatus> {
    const cached = this.keyChecks.get(key);
    if (cached && Date.now() - cached.at < KEY_CHECK_CACHE_MS)
      return cached.ok ? "signed_in" : "key_rejected";
    let ok = true;
    try {
      await this.keys.check(key);
    } catch (error) {
      if (!(error instanceof ApiKeyInvalidError)) throw error;
      ok = false;
    }
    this.keyChecks.set(key, { ok, at: Date.now() });
    return ok ? "signed_in" : "key_rejected";
  }

  /** `~` expanded, absolute, no trailing slash: one spelling per dir for the unique index. */
  private resolveDir(dir: string): string {
    const expanded = dir.startsWith("~") ? path.join(this.cli.home(), dir.slice(1)) : dir;
    return path.resolve(expanded);
  }

  private async notify(): Promise<void> {
    await this.events.publish({ type: "invalidate", collection: "claude_accounts" });
  }
}

function toAccount(
  row: ClaudeAccountRow,
  isDefault: boolean,
  status: ClaudeAccountStatus,
): ClaudeAccount {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    configDir: row.configDir,
    apiKeyHint: row.apiKey ? maskApiKey(row.apiKey) : null,
    email: row.email,
    orgName: row.orgName,
    subscriptionType: row.subscriptionType,
    managed: row.managed,
    isDefault,
    status,
    createdAt: iso(row.createdAt),
  };
}

function authChanged(row: ClaudeAccountRow, auth: ClaudeAuthStatus): boolean {
  return (
    row.email !== auth.email ||
    row.orgName !== auth.orgName ||
    row.subscriptionType !== auth.subscriptionType
  );
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await stat(dir).catch(() => null))?.isDirectory() ?? false;
}
