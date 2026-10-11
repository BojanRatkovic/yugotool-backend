import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type NeedsYouItem, needsYouItemSchema, type ServerEvent } from "@zastava/contracts";
import { LogFile, loadConfig, Supervisor, type SupervisorStatus } from "@zastava/supervisor";
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  nativeTheme,
  powerMonitor,
  shell,
  Tray,
} from "electron";
import { followEvents } from "./events";
import { quitWarning, readPrefs, themeSchema, WINDOW_BACKGROUND, writePrefs } from "./prefs";
import { loginShellPath, withWellKnownDirs } from "./shell-env";
import { flagBitmap, trayMenuTemplate, trayTitle } from "./tray-menu";

const STATIC = path.join(__dirname, "..", "static");
const NEEDS_YOU_POLL_MS = 30_000;
/** Dev/verification only: saves window screenshots (loading, app) into this folder. */
const SHOT_DIR = process.env["ZASTAVA_SCREENSHOT_DIR"];
const needsYouListSchema = needsYouItemSchema.array();

if (!app.requestSingleInstanceLock()) app.quit();

// Finder-launched apps get launchd's PATH; take the login shell's so git, gh,
// nvm and temporal resolve. API and worker run on Electron's own Node.
const shellPath = loginShellPath();
process.env["PATH"] = withWellKnownDirs(shellPath.path ?? process.env["PATH"] ?? "");
/**
 * Packaged app layout (scripts/dist.mjs): code in Resources/app, the web UI in
 * Resources/web. Claude Code and the temporal CLI are fetched on first start
 * from what Resources/app/runtime.json names (spec 0017). A checkout uses its siblings.
 */
const packagedPaths = app.isPackaged
  ? {
      ZASTAVA_BACKEND_ROOT: app.getAppPath(),
      ZASTAVA_WEB_DIST: path.join(process.resourcesPath, "web"),
      ZASTAVA_RUNTIME_MANIFEST: path.join(app.getAppPath(), "runtime.json"),
    }
  : {};
const config = {
  ...loadConfig({
    ...process.env,
    ...packagedPaths,
    ZASTAVA_NODE: process.execPath,
    ZASTAVA_DESKTOP_NOTICES: "app",
  }),
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
/** Set when the OS or a signal asks to quit: no prompt then. */
let forceQuit = false;
/** A quit/restart prompt is open; repeated quit requests wait for it. */
let asking = false;

// Crash logs stay on this Mac: minidumps in ~/.zastava/crashes, the rest in logs/desktop.log.
const log = new LogFile(config.logsDir, "desktop");
log.line(
  shellPath.error
    ? `PATH: login shell failed, using fallback (${shellPath.error}): ${process.env["PATH"]}`
    : `PATH: ${process.env["PATH"]}`,
);
app.setPath("crashDumps", path.join(config.home, "crashes"));
crashReporter.start({ uploadToServer: false });
process.on("uncaughtException", (error) => log.line(`uncaught: ${error.stack ?? String(error)}`));
process.on("unhandledRejection", (reason) =>
  log.line(
    `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  ),
);
app.on("child-process-gone", (_event, details) =>
  log.line(`child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`),
);

const prefsFile = path.join(config.home, "desktop.json");
let prefs = readPrefs(prefsFile);
// The loading screen follows prefers-color-scheme, which follows this.
nativeTheme.themeSource = prefs.theme;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: "ZASTAVA",
    backgroundColor: WINDOW_BACKGROUND[prefs.theme],
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
  // A crashed or killed page would leave a blank window: log it and reload.
  win.webContents.on("render-process-gone", (_event, details) => {
    log.line(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason !== "clean-exit" && !quitting) win.webContents.reload();
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
        restart: () => void restartIfConfirmed(),
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
ipcMain.on("zastava:theme", (_event, value: unknown) => {
  const theme = themeSchema.safeParse(value);
  if (!theme.success || theme.data === prefs.theme) return;
  prefs = { ...prefs, theme: theme.data };
  nativeTheme.themeSource = theme.data;
  window?.setBackgroundColor(WINDOW_BACKGROUND[theme.data]);
  try {
    writePrefs(prefsFile, prefs);
  } catch (error) {
    log.line(`could not save ${prefsFile}: ${String(error)}`);
  }
});

// Without these, a signal (kill, logout) exits before services are stopped.
/** OS shutdown (and signals, where Chromium does not take them first): no prompt. */
const quitNow = (): void => {
  forceQuit = true;
  log.line("quit: requested by the system");
  stopAndExit();
};
process.on("SIGTERM", quitNow);
process.on("SIGINT", quitNow);
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
  // Chromium turns SIGTERM into a plain quit request, so a second request
  // while the prompt is open (⌘Q again, a script, logout) means quit anyway.
  if (forceQuit || asking) {
    if (asking) log.line("quit: requested again while asking, quitting");
    stopAndExit();
  } else void quitIfConfirmed();
});

/** Asks before quitting while agents are working; the OS logging out is never held up. */
async function quitIfConfirmed(): Promise<void> {
  if (await confirmInterrupt("Quit anyway")) stopAndExit();
}

async function restartIfConfirmed(): Promise<void> {
  if ((await confirmInterrupt("Restart anyway")) && !quitting) await restartServices();
}

async function confirmInterrupt(proceed: string): Promise<boolean> {
  const warning = quitWarning((await runningWorkOrders()).map((order) => order.title));
  if (!warning) return true;
  asking = true;
  try {
    open();
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      ...warning,
      buttons: [proceed, "Keep running"],
      defaultId: 1,
      cancelId: 1,
    };
    log.line(`prompt: ${warning.message}`);
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    log.line(`prompt answer: ${options.buttons?.[response] ?? response}`);
    return response === 0;
  } finally {
    asking = false;
  }
}

async function runningWorkOrders(): Promise<NeedsYouItem[]> {
  if (!status || !supervisorReady()) return [];
  try {
    const res = await fetch(`${status.appUrl}/api/work-orders/running`, {
      signal: AbortSignal.timeout(2_000),
    });
    const parsed = needsYouListSchema.safeParse(res.ok ? await res.json() : null);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function stopAndExit(): void {
  if (quitting) return;
  quitting = true;
  stopEvents?.();
  window?.destroy();
  window = null;
  log.line("quit: stopping services");
  void (supervisor?.stop() ?? Promise.resolve()).finally(() => {
    log.line("quit: services stopped");
    void log.close().finally(() => app.exit(0));
  });
}

void (async () => {
  await app.whenReady();
  powerMonitor.on("shutdown", quitNow);
  app.setAboutPanelOptions({
    applicationName: "ZASTAVA",
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 Bojan Ratković",
    credits: "A software factory: work orders through a line of Claude Code agent stations.",
  });
  tray = createTray();
  refreshTray();
  window = createWindow();
  setInterval(() => void refreshNeedsYou(), NEEDS_YOU_POLL_MS);
  await startServices();
})();
