import { once } from "node:events";
import { Injectable, Logger } from "@nestjs/common";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PlanUsage, UsageWindow } from "@zastava/contracts";

/** The probe spawns a Claude Code process; a minute of staleness is fine for a meter. */
const CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;

interface RawWindow {
  utilization: number | null;
  resets_at: string | null;
}

/**
 * Reads claude.ai plan utilization through a short-lived, prompt-less Agent
 * SDK session — no model call, no tokens spent. The SDK method is marked
 * experimental, so every failure degrades to `available: false`.
 */
@Injectable()
export class PlanUsageService {
  private readonly logger = new Logger(PlanUsageService.name);
  private cached: { value: PlanUsage; at: number } | null = null;
  private inflight: Promise<PlanUsage> | null = null;

  async get(): Promise<PlanUsage> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null;
    });
    const value = await this.inflight;
    this.cached = { value, at: Date.now() };
    return value;
  }

  private async probe(): Promise<PlanUsage> {
    // A prompt stream that never yields keeps the session open for control requests only.
    const stop = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          once(stop.signal, "abort").then(() => ({ done: true as const, value: undefined })),
      }),
    };
    const session = query({ prompt: idle, options: { settingSources: [], tools: [] } });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("usage probe timed out")), PROBE_TIMEOUT_MS),
    );
    try {
      const [usage, account] = await Promise.race([
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
        subscriptionType: usage.subscription_type ?? account.subscriptionType ?? null,
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
      return {
        available: false,
        subscriptionType: null,
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        fetchedAt: new Date().toISOString(),
        error: message,
      };
    } finally {
      stop.abort();
      session.close();
    }
  }
}

function toWindow(raw: RawWindow | null | undefined): UsageWindow | null {
  if (!raw) return null;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resets_at ? new Date(raw.resets_at).toISOString() : null,
  };
}
