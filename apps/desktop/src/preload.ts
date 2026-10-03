import { contextBridge, ipcRenderer } from "electron";

/**
 * What the web UI may ask of the desktop shell. The UI feature-detects
 * `window.zastavaDesktop`; in a browser it is undefined.
 */
contextBridge.exposeInMainWorld("zastavaDesktop", {
  platform: process.platform,
  /** Native folder picker; resolves to the chosen path or null. */
  pickFolder: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke("zastava:pick-folder", current),
  /** The web app's theme, so the next loading screen and the window chrome match it. */
  setTheme: (theme: "dark" | "light"): void => ipcRenderer.send("zastava:theme", theme),
  // Loading screen only.
  onStatus: (callback: (status: unknown) => void) =>
    ipcRenderer.on("zastava:status", (_event, status: unknown) => callback(status)),
  onFailed: (callback: (failure: unknown) => void) =>
    ipcRenderer.on("zastava:failed", (_event, failure: unknown) => callback(failure)),
  retry: (): Promise<void> => ipcRenderer.invoke("zastava:retry"),
  openLogs: (): Promise<string> => ipcRenderer.invoke("zastava:open-logs"),
});
