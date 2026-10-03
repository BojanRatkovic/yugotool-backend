import type { BrowserContext } from "playwright";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** True when the browser holds anything worth saving as a session. */
export function hasState(state: StorageState): boolean {
  return state.cookies.length > 0 || state.origins.some((o) => o.localStorage.length > 0);
}
