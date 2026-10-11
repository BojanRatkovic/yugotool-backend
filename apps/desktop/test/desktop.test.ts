import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupervisorStatus } from "@zastava/supervisor";
import { describe, expect, it, vi } from "vitest";
import { parseSse } from "../src/events";
import { quitWarning, readPrefs } from "../src/prefs";
import { loginShellPath, parseShellPath, withWellKnownDirs } from "../src/shell-env";
import { flagBitmap, trayMenuTemplate, trayTitle } from "../src/tray-menu";

describe("parseShellPath", () => {
  it("ignores what rc files print around the marker", () => {
    const out = "Welcome!\n__ZASTAVA_PATH__/opt/homebrew/bin:/usr/bin__ZASTAVA_PATH__\nbye";
    expect(parseShellPath(out)).toBe("/opt/homebrew/bin:/usr/bin");
  });
  it("returns null without both markers", () => {
    expect(parseShellPath("__ZASTAVA_PATH__/usr/bin")).toBeNull();
  });
});

describe("withWellKnownDirs", () => {
  it("puts missing Homebrew dirs in front of launchd's PATH", () => {
    expect(withWellKnownDirs("/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin",
    );
  });
  it("leaves a PATH that already has them as is", () => {
    const full = "/Users/me/.nvm/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin";
    expect(withWellKnownDirs(full)).toBe(full);
  });
});

describe("parseSse", () => {
  it("returns complete data payloads and keeps the tail", () => {
    const { events, rest } = parseSse('id: 1\ndata: {"a":1}\n\n: keep-alive\n\ndata: {"b"');
    expect(events).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b"');
  });
});

const item = (n: number) => ({
  workOrderId: `00000000-0000-4000-8000-00000000000${n}`,
  projectId: "11111111-1111-4111-8111-111111111111",
  projectName: "QA Lab",
  title: `Work order ${n}`,
  since: "2026-10-03T10:00:00.000Z",
});

describe("tray", () => {
  const status: SupervisorStatus = {
    pid: 1,
    startedAt: "2026-10-03T10:00:00.000Z",
    appUrl: "http://127.0.0.1:4810",
    services: [
      {
        name: "postgres",
        state: "running",
        pid: 2,
        port: 4832,
        detail: null,
        restarts: 0,
        since: "",
        logFile: "",
      },
      {
        name: "worker",
        state: "failed",
        pid: null,
        port: null,
        detail: "exited with code 1",
        restarts: 5,
        since: "",
        logFile: "",
      },
    ],
  };
  it("lists waiting work orders that open their deep link", () => {
    const open = vi.fn();
    const menu = trayMenuTemplate(status, [item(1), item(2)], {
      open,
      openLogs: vi.fn(),
      restart: vi.fn(),
      quit: vi.fn(),
    });
    expect(menu.map((m) => m.label)).toContain("2 work orders need you");
    const entry = menu.find((m) => m.label === "Work order 1 · QA Lab");
    if (entry?.click) Reflect.apply(entry.click, undefined, []);
    expect(open).toHaveBeenCalledWith(
      "http://127.0.0.1:4810/projects/11111111-1111-4111-8111-111111111111?view=board&wo=00000000-0000-4000-8000-000000000001",
    );
  });

  it("caps the list and flags a failed service", () => {
    const actions = { open: vi.fn(), openLogs: vi.fn(), restart: vi.fn(), quit: vi.fn() };
    const menu = trayMenuTemplate(status, [1, 2, 3, 4, 5, 6, 7].map(item), actions);
    expect(menu.filter((m) => m.label?.startsWith("Work order"))).toHaveLength(5);
    expect(menu.map((m) => m.label)).toContain("2 more…");
    expect(menu.map((m) => m.label)).toContain("Services · something failed");
  });

  it("shows the count next to the icon only when something waits", () => {
    expect(trayTitle(0)).toBe("");
    expect(trayTitle(3)).toBe(" 3");
  });

  it("draws a template bitmap of the right size", () => {
    const bitmap = flagBitmap(32);
    expect(bitmap).toHaveLength(32 * 32 * 4);
    expect(bitmap.some((byte) => byte === 255)).toBe(true);
  });
});

describe("quitWarning", () => {
  it("stays quiet when nothing runs", () => {
    expect(quitWarning([])).toBeNull();
  });
  it("names the work orders it would cut, at most three", () => {
    expect(quitWarning(["Fix login"])?.message).toBe("A work order is running");
    const many = quitWarning(["a", "b", "c", "d", "e"]);
    expect(many?.message).toBe("5 work orders are running");
    expect(many?.detail).toContain("• c\n• and 2 more");
  });
});

describe("readPrefs", () => {
  it("falls back to dark for a missing or broken file", () => {
    expect(readPrefs("/nonexistent/desktop.json")).toEqual({ theme: "dark" });
  });
});

describe("loginShellPath", () => {
  it("reads the PATH a login shell exports", () => {
    const result = loginShellPath("/bin/sh");
    expect(result.error).toBeNull();
    expect(result.path).toContain("/usr/bin");
  });

  it("gives up on a shell that hangs and ignores SIGTERM", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shell-env-"));
    const shell = path.join(dir, "stuck-shell");
    writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const result = loginShellPath(shell, 300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.path).toBeNull();
    expect(result.error).toContain("ETIMEDOUT");
    rmSync(dir, { recursive: true, force: true });
  });
});
