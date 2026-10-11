import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Client } from "@temporalio/client";
import {
  type ClaudeAccount,
  type DoctorCheck,
  type DoctorCheckKey,
  type DoctorReport,
  TASK_QUEUE,
} from "@zastava/contracts";
import { sql } from "drizzle-orm";
import type { Env } from "../../core/config/env.schema";
import { DatabaseService } from "../../core/database/database.service";
import { TEMPORAL_CLIENT } from "../../core/temporal/temporal.module";
import { ClaudeAccountsService } from "../claude-accounts/claude-accounts.service";
import { SettingsService } from "../settings/settings.service";
import { PlanUsageService } from "./plan-usage.service";

const exec = promisify(execFile);
const CHECK_TIMEOUT_MS = 8_000;
const TEMPORAL_DEADLINE_MS = 3_000;
/** `git hook run` (repo-hooks preflight) needs 2.36. */
const GIT_HOOK_RUN = [2, 36] as const;

type Result = Omit<DoctorCheck, "key" | "label" | "group" | "required" | "neededFor" | "accountId">;
const ok = (detail: string): Result => ({ status: "ok", detail, fix: null, fixCommand: null });
const problem = (
  status: "warn" | "fail",
  detail: string,
  fix: string,
  fixCommand: string | null = null,
): Result => ({ status, detail, fix, fixCommand });

interface Check {
  key: DoctorCheckKey;
  label: string;
  group: DoctorCheck["group"];
  required: boolean;
  neededFor: string | null;
  accountId?: string;
  run: () => Promise<Result>;
}

/**
 * First-run checks: everything a run needs, judged from this machine (the API
 * and the worker share it). Optional pieces fail as `warn`, never `fail`.
 */
@Injectable()
export class DoctorService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly planUsage: PlanUsageService,
    private readonly settings: SettingsService,
    private readonly accounts: ClaudeAccountsService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  async report(): Promise<DoctorReport> {
    // The worker check means nothing without Temporal; it reuses that result.
    const temporal = this.temporalServer();
    const accounts = await this.accounts.list();
    const checks = await Promise.all(this.checks(temporal, accounts).map((c) => this.runCheck(c)));
    return {
      ready: checks.every((c) => !c.required || c.status !== "fail"),
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  private async runCheck(check: Check): Promise<DoctorCheck> {
    const { run, accountId, ...meta } = check;
    const timeout = new Promise<Result>((resolve) =>
      setTimeout(
        () =>
          resolve(
            problem(check.required ? "fail" : "warn", "Check timed out", "Run the check again."),
          ),
        // The Claude probe spawns a session and has its own 20 s timeout.
        check.key === "claude" ? 25_000 : CHECK_TIMEOUT_MS,
      ).unref(),
    );
    const result = await Promise.race([
      run().catch((error: unknown) =>
        problem(
          check.required ? "fail" : "warn",
          error instanceof Error ? error.message : String(error),
          "Run the check again.",
        ),
      ),
      timeout,
    ]);
    return { ...meta, accountId: accountId ?? null, ...result };
  }

  /**
   * "Claude" is what projects get by default: the default account, else this
   * machine's login as before accounts (spec 0016). Every other account gets an
   * optional check of its own: it only stops the projects that use it.
   */
  private checks(temporal: Promise<Result>, accounts: ClaudeAccount[]): Check[] {
    const fallback = accounts.find((a) => a.isDefault);
    return [
      {
        key: "claude",
        label: "Claude",
        group: "machine",
        required: true,
        neededFor: null,
        ...(fallback ? { accountId: fallback.id } : {}),
        run: () => (fallback ? Promise.resolve(accountResult(fallback, true)) : this.claude()),
      },
      ...accounts
        .filter((a) => !a.isDefault)
        .map((account): Check => ({
          key: "claude",
          label: `Claude · ${account.label}`,
          group: "machine",
          required: false,
          neededFor: "Needed for the projects on this account",
          accountId: account.id,
          run: () => Promise.resolve(accountResult(account, false)),
        })),
      {
        key: "git",
        label: "Git",
        group: "machine",
        required: true,
        neededFor: null,
        run: () => git(),
      },
      {
        key: "gh",
        label: "GitHub CLI",
        group: "machine",
        required: false,
        neededFor: "Needed for pull requests",
        run: () => gh(),
      },
      // ZASTAVA's own services: the desktop app starts them; dev starts them by hand.
      {
        key: "database",
        label: "Database",
        group: "service",
        required: true,
        neededFor: null,
        run: () => this.db(),
      },
      {
        key: "temporal",
        label: "Temporal",
        group: "service",
        required: true,
        neededFor: null,
        run: () => temporal,
      },
      {
        key: "worker",
        label: "Worker",
        group: "service",
        required: true,
        neededFor: null,
        run: () => this.worker(temporal),
      },
    ];
  }

  private async claude(): Promise<Result> {
    const { anthropicApiKeySource: keySource } = await this.settings.get();
    if (keySource)
      return ok(keySource === "settings" ? "API key (Settings)" : "API key (ANTHROPIC_API_KEY)");
    const usage = await this.planUsage.get();
    if (usage.subscriptionType) return ok(`Logged in · ${capitalize(usage.subscriptionType)} plan`);
    return problem(
      "fail",
      usage.error ? `Not logged in (${usage.error})` : "Not logged in",
      "Run claude in a terminal and log in with /login, or add an API key in Settings.",
      "claude",
    );
  }

  private async db(): Promise<Result> {
    const result = await this.database.db.execute<{ server_version: string }>(
      sql`show server_version`,
    );
    const version = result.rows[0]?.server_version.split(" ")[0];
    return ok(version ? `Postgres ${version}` : "Connected");
  }

  private async temporalServer(): Promise<Result> {
    const address = this.config.get("TEMPORAL_ADDRESS", { infer: true });
    try {
      const info = await this.temporal.connection.withDeadline(
        Date.now() + TEMPORAL_DEADLINE_MS,
        () => this.temporal.workflowService.getSystemInfo({}),
      );
      return ok(`Server ${info.serverVersion || "running"} on ${address}`);
    } catch {
      return problem(
        "fail",
        `Not reachable on ${address}`,
        "Start the Temporal dev server.",
        "pnpm dev:temporal",
      );
    }
  }

  private async worker(temporal: Promise<Result>): Promise<Result> {
    if ((await temporal).status !== "ok") {
      return problem("fail", "Unknown while Temporal is down", "Start Temporal first.");
    }
    const namespace = this.config.get("TEMPORAL_NAMESPACE", { infer: true });
    const queue = await this.temporal.connection.withDeadline(
      Date.now() + TEMPORAL_DEADLINE_MS,
      () =>
        this.temporal.workflowService.describeTaskQueue({
          namespace,
          taskQueue: { name: TASK_QUEUE },
          // 1 = TASK_QUEUE_TYPE_WORKFLOW
          taskQueueType: 1,
        }),
    );
    const pollers = queue.pollers?.length ?? 0;
    return pollers > 0
      ? // Temporal remembers pollers for minutes, so a count would include restarted workers.
        ok("Running")
      : problem("fail", "Not running", "Start the worker; runs stay queued until it is up.");
  }
}

async function git(): Promise<Result> {
  const out = await exec("git", ["--version"]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (!out)
    return problem(
      "fail",
      "Not installed",
      "Install Git (Xcode command line tools).",
      "xcode-select --install",
    );
  const match = out.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  const version = match?.[0] ?? out;
  const [major, minor] = [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
  const recent = major > GIT_HOOK_RUN[0] || (major === GIT_HOOK_RUN[0] && minor >= GIT_HOOK_RUN[1]);
  return recent
    ? ok(`Git ${version}`)
    : problem(
        "warn",
        `Git ${version}`,
        "Update Git to 2.36 or newer; older versions skip the repo-hooks check before delivery.",
        "brew install git",
      );
}

async function gh(): Promise<Result> {
  const installed = await exec("gh", ["--version"]).then(
    (r) => r.stdout.split("\n")[0]?.match(/\d+\.\d+\.\d+/)?.[0] ?? "installed",
    () => null,
  );
  if (!installed)
    return problem("warn", "Not installed", "Install the GitHub CLI.", "brew install gh");
  const loggedIn = await exec("gh", ["auth", "status"]).then(
    () => true,
    () => false,
  );
  return loggedIn
    ? ok(`gh ${installed} · logged in`)
    : problem("warn", `gh ${installed} · not logged in`, "Log in to GitHub.", "gh auth login");
}

/** An account's status from `claude auth status` (or the key check), as a check result. */
function accountResult(account: ClaudeAccount, required: boolean): Result {
  const failing = required ? "fail" : "warn";
  switch (account.status) {
    case "signed_in":
      if (account.kind === "api_key") return ok(`API key · ${account.apiKeyHint ?? account.label}`);
      return ok(
        [
          "Signed in",
          account.email,
          account.subscriptionType ? `${capitalize(account.subscriptionType)} plan` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    case "signed_out":
      return problem(failing, "Signed out", "Sign in again in Settings → Claude accounts.");
    case "key_rejected":
      return problem(
        failing,
        "Anthropic rejected the API key",
        "Replace the key in Settings → Claude accounts.",
      );
    case "unknown":
      break;
  }
  return problem(
    failing,
    "Could not read the login (claude auth status failed)",
    "Check that Claude Code is installed, then run the check again.",
    "claude --version",
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
