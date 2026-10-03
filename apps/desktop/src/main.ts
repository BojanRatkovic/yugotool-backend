import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type NeedsYouItem, needsYouItemSchema, type ServerEvent } from "@zastava/contracts";
import { loadConfig, Supervisor, type SupervisorStatus } from "@zastava/supervisor";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import { followEvents } from "./events";
import { loginShellPath } from "./shell-env";
import { flagBitmap, trayMenuTemplate, trayTitle } from "./tray-menu";

const STATIC = path.join(__dirname, "..", "static");
const NEEDS_YOU_POLL_MS = 30_000;
/** Dev/verification only: saves window screenshots (loading, app) into this folder. */
const SHOT_DIR = process.env["ZASTAVA_SCREENSHOT_DIR"];
const needsYouListSchema = needsYouItemSchema.array();

if (!app.requestSingleInstanceLock()) app.quit();

// Finder-launched apps get launchd's PATH; take the login shell's so git, gh,
// nvm and temporal resolve. API and worker run on Electron's own Node.
process.env["PATH"] = loginShellPath() ?? process.env["PATH"];
const config = {
  ...loadConfig({ ...process.env, ZASTAVA_NODE: process.execPath, ZASTAVA_DESKTOP_NOTICES: "app" }),
  // The Electron binary runs API and worker as plain Node.
  extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
};

let supervisor: Supervisor | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let status: SupervisorStatus | null = null;
let needsYou: NeedsYouItem[] = [];
let stopEvents: (() => void) | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: "ZASTAVA",
    backgroundColor: "#1c1d21",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Links that leave the app (pull requests, docs) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url) && !url.startsWith("file://")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  // macOS: closing the window keeps ZASTAVA running in the tray.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  void win.loadFile(path.join(STATIC, "loading.html"));
  return win;
}

/** Dev/verification: the app screen, then Settings with the preload bridge checked. */
async function verifyBridge(): Promise<void> {
  if (!SHOT_DIR || !window || !status) return;
  await shot("app");
  await window.loadURL(`${status.appUrl}/settings`);
  await new Promise((r) => setTimeout(r, 3_000));
  const bridge: unknown = await window.webContents.executeJavaScript(
    "typeof window.zastavaDesktop?.pickFolder + ' / Choose buttons: ' + [...document.querySelectorAll('button')].filter(b => b.textContent.trim().startsWith('Choose')).length",
  );
  console.log(`bridge: ${String(bridge)}`);
  await shot("settings");
}

async function shot(name: string): Promise<void> {
  if (!SHOT_DIR || !window) return;
  const image = await window.webContents.capturePage();
  await writeFile(path.join(SHOT_DIR, `desktop-${name}.png`), image.toPNG());
}

function isAppUrl(url: string): boolean {
  return status !== null && url.startsWith(status.appUrl);
}

function open(url?: string): void {
  if (!window) window = createWindow();
  if (status && supervisorReady()) {
    const target = url && isAppUrl(url) ? url : null;
    if (target) void window.loadURL(target);
    else if (!isAppUrl(window.webContents.getURL())) void window.loadURL(status.appUrl);
  }
  window.show();
  window.focus();
}

function supervisorReady(): boolean {
  return status?.services.every((s) => s.state === "running" || s.state === "done") ?? false;
}

async function startServices(): Promise<void> {
  supervisor = new Supervisor(config);
  supervisor.on("status", (next) => {
    status = next;
    window?.webContents.send("zastava:status", next);
    refreshTray();
  });
  window?.webContents.send("zastava:status", supervisor.snapshot());
  setTimeout(() => void shot("loading"), 1_500);
  try {
    await supervisor.start();
  } catch (error) {
    window?.webContents.send("zastava:failed", {
      message: error instanceof Error ? error.message : String(error),
      logsDir: config.logsDir,
    });
    return;
  }
  status = supervisor.snapshot();
  await shot("loading-ready");
  await window?.loadURL(status.appUrl);
  setTimeout(() => void verifyBridge(), 4_000);
  stopEvents = followEvents(`${status.appUrl}/api/events`, onServerEvent);
  void refreshNeedsYou();
}

function onServerEvent(event: ServerEvent): void {
  if (event.type === "notice") {
    const notification = new Notification({ title: event.title, body: event.body });
    notification.on("click", () => open(event.url));
    notification.show();
  } else if (event.type === "invalidate" && event.collection === "work_orders") {
    void refreshNeedsYou();
  }
}

async function refreshNeedsYou(): Promise<void> {
  if (!status) return;
  try {
    const res = await fetch(`${status.appUrl}/api/work-orders/needs-you`);
    const parsed = needsYouListSchema.safeParse(res.ok ? await res.json() : null);
    if (parsed.success) needsYou = parsed.data;
  } catch {
    // API restarting; the next poll catches up
  }
  refreshTray();
}

function refreshTray(): void {
  if (!tray) return;
  tray.setTitle(trayTitle(needsYou.length), { fontType: "monospacedDigit" });
  tray.setToolTip(needsYou.length ? `ZASTAVA · ${needsYou.length} need you` : "ZASTAVA");
  app.dock?.setBadge(needsYou.length ? String(needsYou.length) : "");
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuTemplate(status, needsYou, {
        open,
        openLogs: () => void shell.openPath(config.logsDir),
        restart: () => void restartServices(),
        quit: () => app.quit(),
      }),
    ),
  );
}

async function restartServices(): Promise<void> {
  stopEvents?.();
  await supervisor?.stop();
  await window?.loadFile(path.join(STATIC, "loading.html"));
  await startServices();
}

function createTray(): Tray {
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: flagBitmap(16) });
  icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: flagBitmap(32) });
  icon.setTemplateImage(true);
  return new Tray(icon);
}

ipcMain.handle("zastava:pick-folder", async (_event, current: unknown) => {
  const options: Electron.OpenDialogOptions = {
    title: "Choose your repos folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" ? { defaultPath: current } : {}),
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("zastava:retry", () => restartServices());
ipcMain.handle("zastava:open-logs", () => shell.openPath(config.logsDir));

// Without these, a signal (kill, logout) exits before services are stopped.
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());
app.on("second-instance", () => open());
app.on("activate", () => open());
/**
 * Quit = stop every service first. Any further quit request while stopping is
 * held too; `app.exit` ends the process once the services are down. The
 * window goes first: its open event stream would keep the API from exiting.
 */
app.on("before-quit", (event) => {
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stopEvents?.();
  window?.destroy();
  window = null;
  console.log("quit: stopping services");
  void (supervisor?.stop() ?? Promise.resolve()).finally(() => {
    console.log("quit: services stopped");
    app.exit(0);
  });
});

void (async () => {
  await app.whenReady();
  tray = createTray();
  refreshTray();
  window = createWindow();
  setInterval(() => void refreshNeedsYou(), NEEDS_YOU_POLL_MS);
  await startServices();
})();
