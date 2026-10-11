import type { BrowserContext } from "playwright";
import { z } from "zod";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Where a preview ran: the host browsers open and the two ports it was given. */
export interface PreviewPlace {
  host: string;
  port: number;
  /** `$PORT2`, e.g. a mock API's port; -1 when unknown. */
  port2: number;
}

/** The session file: Playwright's storage state plus where the sign-in ran. */
export type SavedSession = StorageState & { signedInOn?: PreviewPlace | undefined };

const savedSessionSchema = z.object({
  cookies: z.array(
    z
      .object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
      })
      .loose(),
  ),
  origins: z.array(
    z.object({
      origin: z.string(),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
  signedInOn: z.object({ host: z.string(), port: z.number(), port2: z.number() }).optional(),
});

/** Reads a session file's JSON; null when it is not one. */
export function parseSavedSession(raw: string): SavedSession | null {
  try {
    const parsed = savedSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A running preview's place, from its origin and ports. */
export function placeOf(running: { url: string; port: number; port2: number }): PreviewPlace {
  return { host: new URL(running.url).hostname, port: running.port, port2: running.port2 };
}

/** True when the browser holds anything worth saving as a session. */
export function hasState(state: StorageState): boolean {
  return state.cookies.length > 0 || state.origins.some((o) => o.localStorage.length > 0);
}

const LOOPBACK = ["localhost", "127.0.0.1"];

/**
 * Sessions saved before `signedInOn` existed: the one origin on this Mac
 * that holds localStorage is where the sign-in ran. Null when it is ambiguous.
 */
function inferPlace(state: StorageState, host: string): PreviewPlace | null {
  const local = state.origins
    .filter((o) => o.localStorage.length > 0)
    .map((o) => URL.parse(o.origin))
    .filter((url) => url && url.port && [host, ...LOOPBACK].includes(url.hostname));
  if (local.length !== 1 || !local[0]) return null;
  return { host: local[0].hostname, port: Number(local[0].port), port2: -1 };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Moves a saved session to the preview it is used on. Every preview gets
 * fresh ports, and localStorage belongs to one origin (port included), so a
 * session signed in on :54432 is invisible on :52245. Origins on the sign-in
 * ports move to the new ones, and so do `host:port` mentions inside
 * localStorage (apps key their storage by API host, e.g. `auth@localhost-4010`).
 * Cookies ignore ports and are kept as they are. Pure.
 */
export function retargetSession(saved: SavedSession, to: PreviewPlace): StorageState {
  const { signedInOn, ...state } = saved;
  const from = signedInOn ?? inferPlace(state, to.host);
  if (!from) return state;
  const ports = new Map<number, number>();
  if (from.port !== to.port) ports.set(from.port, to.port);
  if (from.port2 > 0 && to.port2 > 0 && from.port2 !== to.port2) ports.set(from.port2, to.port2);
  if (ports.size === 0) return state;

  const hosts = [...new Set([from.host, ...LOOPBACK])];
  const isOurs = (hostname: string): boolean => hosts.includes(hostname);
  // One pass, so a new port that equals another old one is not moved twice.
  const mention = new RegExp(
    `(${hosts.map(escapeRegExp).join("|")})(:|-|_|%3A)(${[...ports.keys()].join("|")})(?!\\d)`,
    "gi",
  );
  const rewrite = (text: string): string =>
    text.replace(
      mention,
      (_, host: string, sep: string, port: string) =>
        `${host.toLowerCase() === from.host ? to.host : host}${sep}${ports.get(Number(port))}`,
    );
  const moveOrigin = (origin: string): string => {
    const url = URL.parse(origin);
    const port = url ? ports.get(Number(url.port)) : undefined;
    if (!url || port === undefined || !isOurs(url.hostname)) return origin;
    return `${url.protocol}//${url.hostname === from.host ? to.host : url.hostname}:${port}`;
  };
  return {
    cookies: state.cookies,
    origins: state.origins.map((o) => ({
      origin: moveOrigin(o.origin),
      localStorage: o.localStorage.map((item) => ({
        name: rewrite(item.name),
        value: rewrite(item.value),
      })),
    })),
  };
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
 * can be diagnosed from YugoTool. URLs are redacted.
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
