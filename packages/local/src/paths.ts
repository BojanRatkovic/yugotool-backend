import os from "node:os";
import path from "node:path";

/** `~/x` → absolute; everything else resolved as given. Pure but for the home dir. */
export function expandHome(location: string): string {
  if (location === "~") return os.homedir();
  if (location.startsWith("~/")) return path.join(os.homedir(), location.slice(2));
  return path.resolve(location);
}
