import type { NeedsYouItem } from "@zastava/contracts";
import type { SupervisorStatus } from "@zastava/supervisor";
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
    { label: "Open ZASTAVA", click: () => actions.open() },
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
    { label: "Quit ZASTAVA", accelerator: "Command+Q", click: actions.quit },
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
 * A small flag mark as a macOS template image (black + alpha, BGRA): a pole
 * and a pennant. `size` is the pixel size (16 at 1x, 32 at 2x).
 */
export function flagBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 16;
  const paint = (x: number, y: number) => {
    const i = (y * size + x) * 4;
    buf[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = x / s;
      const uy = y / s;
      const pole = ux >= 3 && ux < 4.5 && uy >= 1.5 && uy < 15;
      // Pennant: from the pole to the right, 2..9 high, notched at the fly end.
      const inFlag = ux >= 4.5 && ux < 13.5 && uy >= 2 && uy < 9;
      const notch = ux >= 10.5 && Math.abs(uy - 5.5) < (ux - 10.5) * 0.9;
      if (pole || (inFlag && !notch)) paint(x, y);
    }
  }
  return buf;
}
