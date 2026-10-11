import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** What the desktop shell remembers between launches (`~/.yugotool/desktop.json`). */
const prefsSchema = z.object({
  /** The web app's theme, so the loading screen and window chrome match it before the app loads. */
  theme: z.enum(["dark", "light"]).default("dark"),
});
export type DesktopPrefs = z.infer<typeof prefsSchema>;
export const themeSchema = prefsSchema.shape.theme.removeDefault();

export function readPrefs(file: string): DesktopPrefs {
  try {
    return prefsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return prefsSchema.parse({});
  }
}

export function writePrefs(file: string, prefs: DesktopPrefs): void {
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
}

/** Window background per theme (design-system `--background`), shown before the page paints. */
export const WINDOW_BACKGROUND = { dark: "#1c1d21", light: "#fbfbfc" } as const;

/** The quit prompt's text for the running work orders' titles, or null when nothing would be cut. */
export function quitWarning(running: string[]): { message: string; detail: string } | null {
  if (running.length === 0) return null;
  const shown = running.slice(0, 3).map((title) => `• ${title}`);
  if (running.length > 3) shown.push(`• and ${running.length - 3} more`);
  return {
    message:
      running.length === 1
        ? "A work order is running"
        : `${running.length} work orders are running`,
    detail: `${shown.join("\n")}\n\nQuitting stops their agents mid-session and those runs fail. You can retry them after you reopen YugoTool.`,
  };
}
