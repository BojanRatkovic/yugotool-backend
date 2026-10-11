import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { DispatcherState, PlanUsage, Settings } from "@zastava/contracts";
import { enqueueNotification } from "@zastava/notify";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import {
  type AccountAuth,
  ClaudeAccountsService,
} from "../claude-accounts/claude-accounts.service";
import { SettingsService } from "../settings/settings.service";
import { PlanUsageService } from "../system/plan-usage.service";
import { WorkOrdersRepository } from "../work-orders/work-orders.repository";
import { WorkOrdersService } from "../work-orders/work-orders.service";
import { inWindow, nextOccurrence } from "./night-shift";

const TICK_MS = 15_000;

interface UsageBlock {
  reason: string;
  resumesAt: string | null;
}

/**
 * Starts queued work orders when there is a free slot, plan headroom and —
 * for night-mode orders — the night shift is on. All state lives in Postgres
 * (status = queued), so a restart loses nothing; this loop is only the pump.
 */
@Injectable()
export class DispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private state: DispatcherState | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly workOrders: WorkOrdersService,
    private readonly repository: WorkOrdersRepository,
    private readonly settings: SettingsService,
    private readonly planUsage: PlanUsageService,
    private readonly accounts: ClaudeAccountsService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async current(): Promise<DispatcherState> {
    return this.state ?? (await this.tick());
  }

  async tick(): Promise<DispatcherState> {
    if (this.ticking && this.state) return this.state;
    this.ticking = true;
    try {
      const next = await this.evaluate(new Date());
      const changed =
        next.status !== this.state?.status ||
        next.reason !== this.state.reason ||
        next.running !== this.state.running;
      const paused = next.status === "paused_usage" && this.state?.status !== "paused_usage";
      this.state = next;
      if (paused) await this.notifyPaused(next);
      if (changed) await this.events.publish({ type: "invalidate", collection: "dispatcher" });
      return next;
    } catch (error) {
      this.logger.error("dispatcher tick failed", error instanceof Error ? error.stack : error);
      return this.state ?? this.idle(new Date(), 0, "Dispatcher error, retrying");
    } finally {
      this.ticking = false;
    }
  }

  /** Once per pause: the dedupe key is the reset time, so a restart does not repeat it. */
  private async notifyPaused(state: DispatcherState): Promise<void> {
    await enqueueNotification(
      this.database.db,
      { kind: "dispatcher_paused", payload: { reason: state.reason, resumesAt: state.resumesAt } },
      `dispatcher_paused:${state.resumesAt ?? state.checkedAt.slice(0, 13)}`,
    );
  }

  private async evaluate(now: Date): Promise<DispatcherState> {
    const settings = await this.settings.get();
    // A split's follower joins the queue once its predecessor is delivered (spec 0014).
    if ((await this.repository.enqueueReadyFollowers(this.database.db)) > 0) {
      await this.events.publish({ type: "invalidate", collection: "work_orders" });
    }
    const running = await this.repository.countByStatus(this.database.db, ["running"]);
    const queued = await this.repository.listQueued(this.database.db);
    const night = inWindow(now, settings.nightShiftStart, settings.nightShiftEnd);
    const eligible = queued.filter((w) => w.queueMode !== "night" || night);
    const queuedNight = queued.filter((w) => w.queueMode === "night").length;
    const slots = Math.max(0, settings.maxConcurrentRuns - running);
    const base = {
      running,
      queued: queued.length,
      queuedNight,
      slots,
      inNightShift: night,
      checkedAt: now.toISOString(),
    };
    const shift = `${settings.nightShiftStart}–${settings.nightShiftEnd}`;

    if (queued.length === 0) return this.idle(now, running, "Nothing queued", base);
    if (eligible.length === 0) {
      return {
        ...base,
        status: "waiting_night_shift",
        reason: `${queuedNight} queued for the night shift (${shift})`,
        resumesAt: nextOccurrence(now, settings.nightShiftStart).toISOString(),
      };
    }

    // Each queued order waits on its own account's plan (spec 0016): a full
    // account pauses only its projects. Probed only when there is work to start
    // (the probe spawns a process); API keys do not draw from a plan.
    const auths = new Map<string, AccountAuth>();
    for (const projectId of new Set(eligible.map((w) => w.projectId))) {
      auths.set(projectId, await this.accounts.authFor(projectId));
    }
    const blocks = new Map<string, { label: string; block: UsageBlock | null }>();
    for (const auth of auths.values()) {
      const key = accountKey(auth);
      if (blocks.has(key)) continue;
      const block = auth.billsPlan ? usageBlock(await this.planUsage.get(auth), settings) : null;
      blocks.set(key, { label: auth.label, block });
    }
    const plan = planDispatch(
      eligible.map((w) => ({ id: w.id, account: accountKey(auths.get(w.projectId)!) })),
      new Map([...blocks].map(([key, value]) => [key, value.block !== null])),
      slots,
    );
    const paused = plan.blocked.map((key) => blocks.get(key)!);
    if (plan.start.length === 0 && paused.length > 0) {
      return { ...base, status: "paused_usage", ...pausedReason(paused) };
    }

    let started = 0;
    for (const id of plan.start) {
      try {
        await this.workOrders.start(id);
        started += 1;
      } catch (error) {
        this.logger.warn(
          `could not start ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const nowRunning = running + started;
    return {
      ...base,
      running: nowRunning,
      queued: queued.length - started,
      slots: Math.max(0, settings.maxConcurrentRuns - nowRunning),
      status: "active",
      reason:
        `${nowRunning}/${settings.maxConcurrentRuns} running` +
        (queued.length - started > 0 ? ` · ${queued.length - started} queued` : "") +
        (paused.length > 0 ? ` · paused: ${pausedReason(paused).reason}` : ""),
      resumesAt: null,
    };
  }

  private idle(
    now: Date,
    running: number,
    reason: string,
    base?: Omit<DispatcherState, "status" | "reason" | "resumesAt">,
  ): DispatcherState {
    return {
      running,
      queued: 0,
      queuedNight: 0,
      slots: 0,
      inNightShift: false,
      checkedAt: now.toISOString(),
      ...base,
      status: "idle",
      reason,
      resumesAt: null,
    };
  }
}

const accountKey = (auth: AccountAuth): string => auth.accountId ?? "env";

/**
 * Which queued work orders to start, in queue order (spec 0016): only those
 * whose account has headroom, up to the free slots. `blocked`: the accounts
 * that held back at least one order. Pure.
 */
export function planDispatch(
  queue: { id: string; account: string }[],
  blocked: Map<string, boolean>,
  slots: number,
): { start: string[]; blocked: string[] } {
  const ready = queue.filter((w) => !blocked.get(w.account));
  const held = new Set(queue.filter((w) => blocked.get(w.account)).map((w) => w.account));
  return { start: ready.slice(0, slots).map((w) => w.id), blocked: [...held] };
}

/** One account: its reason as before accounts. Several: each named, the earliest reset. */
function pausedReason(paused: { label: string; block: UsageBlock | null }[]): {
  reason: string;
  resumesAt: string | null;
} {
  const blocks = paused.flatMap((p) => (p.block ? [{ label: p.label, ...p.block }] : []));
  if (blocks.length === 1) return { reason: blocks[0]!.reason, resumesAt: blocks[0]!.resumesAt };
  const resets = blocks.flatMap((b) => (b.resumesAt ? [b.resumesAt] : [])).toSorted();
  return {
    reason: blocks.map((b) => `${b.label}: ${b.reason}`).join(" · "),
    resumesAt: resets[0] ?? null,
  };
}

/** Plan limits only apply to subscription auth; an unavailable probe never blocks. */
function usageBlock(usage: PlanUsage, settings: Settings): UsageBlock | null {
  if (!usage.available) return null;
  const five = usage.fiveHour?.utilization ?? null;
  if (five !== null && five >= settings.pauseAtFiveHourPct) {
    return {
      reason: `5-hour usage ${five}% (limit ${settings.pauseAtFiveHourPct}%)`,
      resumesAt: usage.fiveHour?.resetsAt ?? null,
    };
  }
  const week = usage.sevenDay?.utilization ?? null;
  if (week !== null && week >= settings.pauseAtWeeklyPct) {
    return {
      reason: `Weekly usage ${week}% (limit ${settings.pauseAtWeeklyPct}%)`,
      resumesAt: usage.sevenDay?.resetsAt ?? null,
    };
  }
  return null;
}
