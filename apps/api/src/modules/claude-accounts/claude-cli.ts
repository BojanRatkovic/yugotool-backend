import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { claudeAccountEnv } from "@zastava/contracts";
import { z } from "zod";
import { childProcessEnv, type Env } from "../../core/config/env.schema";

const exec = promisify(execFile);

const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullish(),
  orgName: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});
const STATUS_TIMEOUT_MS = 10_000;

/** What `claude auth status --json` says about a config dir. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

/** The `claude auth …` commands, each run against one config dir (spec 0016). */
@Injectable()
export class ClaudeCli {
  constructor(private readonly config: ConfigService<Env, true>) {}

  home(): string {
    return os.homedir();
  }

  /** null: `claude` could not be run or printed something unreadable. */
  async status(configDir: string): Promise<ClaudeAuthStatus | null> {
    let stdout: string;
    try {
      ({ stdout } = await exec(this.bin(), ["auth", "status", "--json"], {
        env: this.envFor(configDir),
        timeout: STATUS_TIMEOUT_MS,
      }));
    } catch (error) {
      // Signed out exits 1 and still prints the JSON.
      if (!(error instanceof Error && "stdout" in error && typeof error.stdout === "string"))
        return null;
      stdout = error.stdout;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      return null;
    }
    const parsed = authStatusSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { loggedIn, email, orgName, subscriptionType } = parsed.data;
    return {
      loggedIn,
      email: email ?? null,
      orgName: orgName ?? null,
      subscriptionType: subscriptionType ?? null,
    };
  }

  /** `claude auth login`, which opens the browser itself and also prints a manual link. */
  login(configDir: string, email: string | undefined): ChildProcessWithoutNullStreams {
    const args = ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])];
    return spawn(this.bin(), args, { env: this.envFor(configDir), stdio: "pipe" });
  }

  /** Best effort: drops the dir's keychain item before ZASTAVA deletes a dir it created. */
  async logout(configDir: string): Promise<void> {
    await exec(this.bin(), ["auth", "logout"], {
      env: this.envFor(configDir),
      timeout: STATUS_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  private envFor(configDir: string): NodeJS.ProcessEnv {
    return claudeAccountEnv(
      childProcessEnv(),
      { kind: "config_dir", configDir, apiKey: null },
      this.home(),
    );
  }

  private bin(): string {
    return this.config.get("CLAUDE_BIN", { infer: true });
  }
}
