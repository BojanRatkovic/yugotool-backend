import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@zastava/contracts";

const exec = promisify(execFile);
const TIMEOUT_MS = 10_000;

export type Channel = "desktop" | "slack" | "telegram";

export interface Notice {
  title: string;
  body: string;
  /** Deep link into the app; channels that support links render it. */
  url: string;
}

type ChannelSettings = Pick<
  Settings,
  "desktopNotifications" | "slackWebhookUrl" | "telegramBotToken" | "telegramChatId"
>;

/** Delivers a desktop notice; default: osascript (macOS). The desktop app swaps in its own. */
export type DesktopSink = (notice: Notice) => Promise<void>;

/** Fits a notice into a `notice` event (NOTIFY payloads cap at 8 kB). */
export function truncateNotice(notice: Notice): Notice {
  return {
    title: cut(notice.title, 200),
    body: cut(notice.body, 2_000),
    url: cut(notice.url, 1_000),
  };
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class ChannelNotConfiguredError extends Error {
  constructor(channel: Channel) {
    super(`${channel} notifications are not configured`);
    this.name = "ChannelNotConfiguredError";
  }
}

/** Channels with enough settings to send. */
export function enabledChannels(settings: ChannelSettings): Channel[] {
  const channels: Channel[] = [];
  if (settings.desktopNotifications) channels.push("desktop");
  if (settings.slackWebhookUrl) channels.push("slack");
  if (settings.telegramBotToken && settings.telegramChatId) channels.push("telegram");
  return channels;
}

export async function send(
  channel: Channel,
  settings: ChannelSettings,
  notice: Notice,
  desktop: DesktopSink = sendDesktop,
): Promise<void> {
  switch (channel) {
    case "desktop":
      return desktop(notice);
    case "slack":
      if (!settings.slackWebhookUrl) throw new ChannelNotConfiguredError(channel);
      return postJson(settings.slackWebhookUrl, {
        text: `*${notice.title}*\n${notice.body}\n<${notice.url}|Open in ZASTAVA>`,
      });
    case "telegram":
      if (!settings.telegramBotToken || !settings.telegramChatId) {
        throw new ChannelNotConfiguredError(channel);
      }
      return postJson(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        chat_id: settings.telegramChatId,
        text: `${notice.title}\n${notice.body}\n${notice.url}`,
        disable_web_page_preview: true,
      });
  }
}

/** Fans out to every enabled channel; one failing channel never blocks the others. */
export async function broadcast(
  settings: ChannelSettings,
  notice: Notice,
  desktop?: DesktopSink,
): Promise<{ channel: Channel; error: string | null }[]> {
  return Promise.all(
    enabledChannels(settings).map(async (channel) => {
      try {
        await send(channel, settings, notice, desktop);
        return { channel, error: null };
      } catch (error) {
        return { channel, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** macOS only (the local runner's platform); a no-op elsewhere. */
async function sendDesktop(notice: Notice): Promise<void> {
  if (process.platform !== "darwin") return;
  const script = `display notification ${appleString(notice.body)} with title ${appleString(
    "ZASTAVA",
  )} subtitle ${appleString(notice.title)}`;
  await exec("osascript", ["-e", script], { timeout: TIMEOUT_MS });
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}
export { enqueueNotification } from "./enqueue";
