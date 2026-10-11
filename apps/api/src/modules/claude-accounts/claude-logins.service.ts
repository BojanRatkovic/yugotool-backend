import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { ClaudeAccountLogin, StartClaudeLogin } from "@zastava/contracts";
import {
  ClaudeLoginFinishedError,
  ClaudeLoginNotFoundError,
  ClaudeLoginNotSupportedError,
} from "./claude-accounts.errors";
import { ClaudeAccountsService } from "./claude-accounts.service";
import { ClaudeCli } from "./claude-cli";

/** Nobody finishes a browser login after this; the process is stopped. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** A finished login stays readable this long, for the dialog's last poll. */
const KEEP_FINISHED_MS = 15 * 60_000;

interface Login {
  view: ClaudeAccountLogin;
  child: ChildProcessWithoutNullStreams | null;
  /** Set when this login created the dir: deleted again if it does not succeed. */
  createdDir: string | null;
  stderr: string;
  timer: NodeJS.Timeout | null;
}

/**
 * `claude auth login` runs without a TTY (spec 0016 §8, T1): it opens the
 * browser on a localhost callback, prints a manual link, and takes a pasted
 * code on stdin. Exit 0 means signed in.
 */
@Injectable()
export class ClaudeLoginsService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeLoginsService.name);
  private readonly logins = new Map<string, Login>();

  constructor(
    private readonly accounts: ClaudeAccountsService,
    private readonly cli: ClaudeCli,
  ) {}

  async start(input: StartClaudeLogin): Promise<ClaudeAccountLogin> {
    let configDir: string;
    let createdDir: string | null = null;
    if (input.accountId) {
      const account = await this.accounts.find(input.accountId);
      if (account.kind !== "config_dir" || !account.configDir)
        throw new ClaudeLoginNotSupportedError("An API key account has no login: replace the key.");
      configDir = account.configDir;
    } else {
      configDir = createdDir = await this.accounts.createManagedDir(
        input.label ?? input.email ?? "account",
      );
    }

    const id = crypto.randomUUID();
    const child = this.cli.login(configDir, input.email);
    const login: Login = {
      view: { id, accountId: input.accountId ?? null, state: "pending", url: null, error: null },
      child,
      createdDir,
      stderr: "",
      timer: setTimeout(
        () => this.fail(login, "Sign-in timed out. Start it again."),
        LOGIN_TIMEOUT_MS,
      ),
    };
    this.logins.set(id, login);

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      login.view.url ??= manualLoginUrl(stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      login.stderr += chunk.toString();
    });
    child.on("error", (error) => this.fail(login, `Could not run claude: ${error.message}`));
    child.on("close", (code) => {
      login.child = null;
      if (login.view.state !== "pending") return;
      if (code === 0) void this.finish(login, configDir, input.label ?? null);
      else this.fail(login, lastLine(login.stderr) ?? `claude auth login exited with ${code}`);
    });
    return { ...login.view };
  }

  get(id: string): ClaudeAccountLogin {
    return { ...this.login(id).view };
  }

  /** The code the manual link's page shows, written to the waiting `claude`. */
  submitCode(id: string, code: string): ClaudeAccountLogin {
    const login = this.login(id);
    if (login.view.state !== "pending" || !login.child)
      throw new ClaudeLoginFinishedError("This sign-in already finished.");
    login.child.stdin.write(`${code}\n`);
    return { ...login.view };
  }

  cancel(id: string): void {
    const login = this.login(id);
    if (login.view.state === "pending") this.fail(login, "Cancelled.");
  }

  /** A sign-in cut off by shutdown leaves no half-made dir behind (sync: the process is ending). */
  onModuleDestroy(): void {
    for (const login of this.logins.values()) {
      login.child?.kill();
      if (login.timer) clearTimeout(login.timer);
      if (login.view.state === "pending" && login.createdDir)
        rmSync(login.createdDir, { recursive: true, force: true });
    }
  }

  private login(id: string): Login {
    const login = this.logins.get(id);
    if (!login) throw new ClaudeLoginNotFoundError(`sign-in ${id} not found`);
    return login;
  }

  /** `label`: what the person typed; a new account is otherwise named by its email. */
  private async finish(login: Login, configDir: string, label: string | null): Promise<void> {
    try {
      const auth = await this.cli.status(configDir);
      if (!auth?.loggedIn) return this.fail(login, "claude finished but is not signed in.");
      const accountId = await this.accounts.saveLogin(
        login.view.accountId,
        { label: label ?? auth.email ?? "Claude account", configDir },
        auth,
      );
      this.settle(login, { state: "done", accountId });
    } catch (error) {
      this.fail(login, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(login: Login, error: string): void {
    if (login.view.state !== "pending") return;
    login.child?.kill();
    this.settle(login, { state: "failed", error });
    if (login.createdDir) {
      rm(login.createdDir, { recursive: true, force: true }).catch((e: unknown) =>
        this.logger.warn(`could not remove ${login.createdDir}: ${String(e)}`),
      );
    }
  }

  private settle(login: Login, patch: Partial<ClaudeAccountLogin>): void {
    login.view = { ...login.view, ...patch };
    if (login.timer) clearTimeout(login.timer);
    login.timer = null;
    setTimeout(() => this.logins.delete(login.view.id), KEEP_FINISHED_MS).unref();
  }
}

/**
 * The manual link `claude auth login` prints (inside an OSC 8 hyperlink); its
 * page shows a code to paste back. Null until printed.
 */
export function manualLoginUrl(stdout: string): string | null {
  return /https:\/\/[\w.-]+\/[\w./-]*oauth\/authorize\?[\w.~%&=+-]+/.exec(stdout)?.[0] ?? null;
}

function lastLine(text: string): string | null {
  return text.trim().split("\n").at(-1)?.trim() || null;
}
