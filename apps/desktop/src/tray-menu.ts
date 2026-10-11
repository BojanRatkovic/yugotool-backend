import type { NeedsYouItem } from "@yugotool/contracts";
import type { SupervisorStatus } from "@yugotool/supervisor";
import type { MenuItemConstructorOptions } from "electron";

export interface TrayActions {
  open: (url?: string) => void;
  openLogs: () => void;
  restart: () => void;
  quit: () => void;
}

const MAX_ITEMS = 5;
const STATE_LABEL: Record<SupervisorStatus["services"][number]["state"], string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  done: "Done",
  restarting: "Restarting…",
  failed: "Failed",
};

/** The tray menu for the current state. Pure (no Electron calls), so it is testable. */
export function trayMenuTemplate(
  status: SupervisorStatus | null,
  needsYou: NeedsYouItem[],
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const appUrl = status?.appUrl;
  const waiting: MenuItemConstructorOptions[] = needsYou.length
    ? [
        {
          label:
            needsYou.length === 1
              ? "1 work order needs you"
              : `${needsYou.length} work orders need you`,
          enabled: false,
        },
        ...needsYou.slice(0, MAX_ITEMS).map((item) => ({
          label: `${truncate(item.title, 48)} · ${item.projectName}`,
          click: () =>
            actions.open(
              appUrl && `${appUrl}/projects/${item.projectId}?view=board&wo=${item.workOrderId}`,
            ),
        })),
        ...(needsYou.length > MAX_ITEMS
          ? [{ label: `${needsYou.length - MAX_ITEMS} more…`, click: () => actions.open() }]
          : []),
      ]
    : [{ label: "Nothing needs you", enabled: false }];

  const failed = status?.services.some((s) => s.state === "failed") ?? false;
  return [
    { label: "Open YugoTool", click: () => actions.open() },
    { type: "separator" },
    ...waiting,
    { type: "separator" },
    {
      label: failed ? "Services · something failed" : "Services",
      submenu: [
        ...(status?.services ?? []).map((s) => ({
          label: `${s.name} — ${STATE_LABEL[s.state]}${s.state === "failed" && s.detail ? `: ${truncate(s.detail, 60)}` : ""}`,
          enabled: false,
        })),
        { type: "separator" as const },
        { label: "Restart services", click: actions.restart },
        { label: "Open logs folder", click: actions.openLogs },
      ],
    },
    { type: "separator" },
    { label: "Quit YugoTool", accelerator: "Command+Q", click: actions.quit },
  ];
}

/** Title shown next to the tray icon: the waiting count, empty when zero. */
export function trayTitle(needsYou: number): string {
  return needsYou > 0 ? ` ${needsYou}` : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The mark as a macOS template image (black + alpha, BGRA): the milling
 * cutter's toothed ring and the Y, the bore left clear. `size` is the pixel
 * size (16 at 1x, 32 at 2x); 4×4 samples per pixel smooth the edges.
 */
export function markBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const teeth = 12;
  const first = (-84 * Math.PI) / 180;
  const y: [number, number, number, number][] = [
    [11.22, 10.48, 16, 16.18],
    [20.78, 10.48, 16, 16.18],
    [16, 16.18, 16, 22.44],
  ];
  const inside = (ux: number, uy: number): boolean => {
    const r = Math.hypot(ux - 16, uy - 16);
    const turn = (Math.atan2(uy - 16, ux - 16) - first) / ((2 * Math.PI) / teeth);
    const phase = turn - Math.floor(turn);
    // Cutting face, a short land at the tip, then the back slopes to the next face.
    const outer = phase < 0.28 ? 15 : 15 - ((phase - 0.28) / 0.72) * 3.6;
    if (r > 9.6 && r <= outer) return true;
    return y.some(([x1, y1, x2, y2]) => segmentDistance(ux, uy, x1, y1, x2, y2) <= 1.4);
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const ux = ((px + (sx + 0.5) / 4) / size) * 32;
          const uy = ((py + (sy + 0.5) / 4) / size) * 32;
          if (inside(ux, uy)) hits += 1;
        }
      }
      buf[(py * size + px) * 4 + 3] = Math.round((hits / 16) * 255);
    }
  }
  return buf;
}

function segmentDistance(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
