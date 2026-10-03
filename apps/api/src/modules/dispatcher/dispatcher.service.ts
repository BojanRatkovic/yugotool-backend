import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { DispatcherState, PlanUsage, Settings } from "@zastava/contracts";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
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
      this.state = next;
      if (changed) await this.events.publish({ type: "invalidate", collection: "dispatcher" });
      return next;
    } catch (error) {
      this.logger.error("dispatcher tick failed", error instanceof Error ? error.stack : error);
      return this.state ?? this.idle(new Date(), 0, "Dispatcher error, retrying");
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(now: Date): Promise<DispatcherState> {
    const settings = await this.settings.get();
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

    // Probe the plan only when there is work to start: the probe spawns a process.
    // On an API key, agents do not draw from the plan, so its limits do not apply.
    const block = (await this.settings.apiKey())
      ? null
      : usageBlock(await this.planUsage.get(), settings);
    if (block)
      return { ...base, status: "paused_usage", reason: block.reason, resumesAt: block.resumesAt };

    let started = 0;
    for (const workOrder of eligible.slice(0, slots)) {
      try {
        await this.workOrders.start(workOrder.id);
        started += 1;
      } catch (error) {
        this.logger.warn(
          `could not start ${workOrder.id}: ${error instanceof Error ? error.message : String(error)}`,
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
        (queued.length - started > 0 ? ` · ${queued.length - started} queued` : ""),
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
