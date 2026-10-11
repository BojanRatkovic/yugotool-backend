import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pinnedPnpm } from "./node-versions";

const dir = mkdtempSync(path.join(os.tmpdir(), "zastava-pnpm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pinned pnpm", () => {
  it("reads the version from packageManager, without the hash", async () => {
    writeFileSync(path.join(dir, "package.json"), '{"packageManager":"pnpm@12.4.1+sha512.abc"}');
    expect(await pinnedPnpm(dir)).toBe("12.4.1");
    writeFileSync(path.join(dir, "package.json"), '{"packageManager":"yarn@4.1.0"}');
    expect(await pinnedPnpm(dir)).toBeNull();
    rmSync(path.join(dir, "package.json"));
    expect(await pinnedPnpm(dir)).toBeNull();
  });
});
