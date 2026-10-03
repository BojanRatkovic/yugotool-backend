import type { BrowserContext } from "playwright";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** True when the browser holds anything worth saving as a session. */
export function hasState(state: StorageState): boolean {
  return state.cookies.length > 0 || state.origins.some((o) => o.localStorage.length > 0);
}

/** Origin + path only: query strings and fragments can carry tokens. */
export function redactUrl(raw: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(raw);
  return match ? `${match[1]}${match[2] || "/"}` : (raw.split(/[?#]/)[0] ?? raw);
}

const TRACE_LINES = 150;
/** Main-frame navigations within this window that suggest a redirect loop. */
const LOOP_WINDOW_MS = 20_000;
const LOOP_NAVIGATIONS = 10;

/**
 * What happened in the sign-in window (navigations, failed requests, console
 * errors), so a sign-in that goes wrong — e.g. app ↔ login redirect loops —
 * can be diagnosed from ZASTAVA. URLs are redacted.
 */
export class BrowserTrace {
  private readonly lines: string[] = [];
  private readonly navigations: number[] = [];
  private loopNoted = false;
  version = 0;

  constructor(private readonly now: () => number = Date.now) {}

  add(line: string): void {
    const time = new Date(this.now()).toISOString().slice(11, 19);
    this.lines.push(`${time} ${line}`);
    if (this.lines.length > TRACE_LINES) this.lines.shift();
    this.version++;
  }

  navigated(url: string): void {
    const now = this.now();
    this.navigations.push(now);
    while (this.navigations.length && this.navigations[0]! < now - LOOP_WINDOW_MS)
      this.navigations.shift();
    this.add(`→ ${redactUrl(url)}`);
    if (!this.loopNoted && this.loopSuspected()) {
      this.loopNoted = true;
      this.add(
        `⚠ ${this.navigations.length} page loads in ${LOOP_WINDOW_MS / 1000}s: looks like a redirect loop`,
      );
    }
  }

  loopSuspected(): boolean {
    return this.navigations.length >= LOOP_NAVIGATIONS;
  }

  text(): string {
    return this.lines.join("\n");
  }
}
