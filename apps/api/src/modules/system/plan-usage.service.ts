import { once } from "node:events";
import { Injectable, Logger } from "@nestjs/common";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import { claudeAccountEnv, type PlanUsage, type UsageWindow } from "@yugotool/contracts";
import { childProcessEnv, claudeExecutable } from "../../core/config/env.schema";
import type { AccountAuth } from "../claude-accounts/claude-accounts.service";

/** The probe spawns a Claude Code process; a minute of staleness is fine for a meter. */
const CACHE_MS = 60_000;
/** A failed probe (cold start, network) is tried again soon, not shown for a minute. */
const FAILED_CACHE_MS = 5_000;
const PROBE_TIMEOUT_MS = 20_000;

interface RawWindow {
  utilization: number | null;
  resets_at: string | null;
}

/**
 * Reads claude.ai plan utilization through a short-lived, prompt-less Agent
 * SDK session — no model call, no tokens spent. The SDK method is marked
 * experimental, so every failure degrades to `available: false`. One cache per
 * Claude account (spec 0016); no account = the environment's login.
 */
@Injectable()
export class PlanUsageService {
  private readonly logger = new Logger(PlanUsageService.name);
  private readonly cached = new Map<string, { value: PlanUsage; at: number }>();
  private readonly inflight = new Map<string, Promise<PlanUsage>>();

  async get(account: Pick<AccountAuth, "accountId" | "target"> | null = null): Promise<PlanUsage> {
    const key = account?.accountId ?? "env";
    const hit = this.cached.get(key);
    if (hit && Date.now() - hit.at < (hit.value.error ? FAILED_CACHE_MS : CACHE_MS))
      return hit.value;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.probe(account).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await pending;
    this.cached.set(key, { value, at: Date.now() });
    return value;
  }

  private async probe(account: Pick<AccountAuth, "target"> | null): Promise<PlanUsage> {
    // An API key has no plan to read.
    if (account?.target?.kind === "api_key") return unavailable(null);
    // A prompt stream that never yields keeps the session open for control requests only.
    const stop = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          once(stop.signal, "abort").then(() => ({ done: true as const, value: undefined })),
      }),
    };
    const env = account?.target
      ? claudeAccountEnv(childProcessEnv(), account.target, os.homedir())
      : undefined;
    const session = query({
      prompt: idle,
      options: { settingSources: [], tools: [], ...claudeExecutable(), ...(env ? { env } : {}) },
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("usage probe timed out")), PROBE_TIMEOUT_MS),
    );
    try {
      const [usage, info] = await Promise.race([
        Promise.all([
          session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }),
          session.accountInfo(),
        ]),
        timeout,
      ]);
      const limits = usage.rate_limits;
      return {
        available: usage.rate_limits_available && limits !== null,
        subscriptionType: usage.subscription_type ?? info.subscriptionType ?? null,
        fiveHour: toWindow(limits?.five_hour),
        sevenDay: toWindow(limits?.seven_day),
        sevenDayOpus: toWindow(limits?.seven_day_opus),
        sevenDaySonnet: toWindow(limits?.seven_day_sonnet),
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`plan usage probe failed: ${message}`);
      return unavailable(message);
    } finally {
      stop.abort();
      session.close();
    }
  }
}

function unavailable(error: string | null): PlanUsage {
  return {
    available: false,
    subscriptionType: null,
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    fetchedAt: new Date().toISOString(),
    error,
  };
}

function toWindow(raw: RawWindow | null | undefined): UsageWindow | null {
  if (!raw) return null;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resets_at ? new Date(raw.resets_at).toISOString() : null,
  };
}
