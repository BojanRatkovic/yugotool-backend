import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Folders macOS guards with a "would like to access files in your … folder"
 * dialog. Until it is answered every read inside waits, so an API scanning
 * ~/Desktop/Developer hangs with it (spec 0017 §6).
 */
const PROTECTED = ["Desktop", "Documents", "Downloads"];

/** The guarded folders that hold any of `paths`, in a fixed order. Pure. */
export function protectedFolders(paths: string[], home = os.homedir()): string[] {
  return PROTECTED.map((name) => path.join(home, name)).filter((folder) =>
    paths.some((p) => {
      const resolved = path.resolve(p);
      return resolved === folder || resolved.startsWith(folder + path.sep);
    }),
  );
}

export type FolderAccess = "granted" | "denied";

/**
 * Reads `folder` in a child process, which macOS attributes to the app and
 * answers with its dialog. `onWaiting` fires when the read is still blocked
 * after `waitingAfterMs`: the dialog is up. Waits as long as the person takes.
 */
export function checkFolderAccess(
  folder: string,
  options: { onWaiting?: () => void; signal?: AbortSignal; waitingAfterMs?: number } = {},
): Promise<FolderAccess> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/ls", [folder], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const waiting = setTimeout(() => options.onWaiting?.(), options.waitingAfterMs ?? 1_000);
    const abort = (): void => {
      child.kill("SIGKILL");
      reject(new Error("stopped"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(waiting);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(waiting);
      options.signal?.removeEventListener("abort", abort);
      // A missing folder is not ours to report; only a refusal is.
      resolve(code !== 0 && /not permitted/i.test(stderr) ? "denied" : "granted");
    });
  });
}
