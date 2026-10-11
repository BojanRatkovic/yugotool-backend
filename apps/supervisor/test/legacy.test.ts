import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { moveLegacyHome } from "../src/legacy";

const userHome = (): string => realpathSync(mkdtempSync(path.join(tmpdir(), "yugotool-user-")));

describe("moveLegacyHome", () => {
  it("moves ~/.zastava to ~/.yugotool and leaves a symlink to it", () => {
    const user = userHome();
    const legacy = path.join(user, ".zastava");
    mkdirSync(path.join(legacy, "pg"), { recursive: true });
    writeFileSync(path.join(legacy, "pg", "PG_VERSION"), "18\n");
    const home = path.join(user, ".yugotool");

    expect(moveLegacyHome(home, user)).toBe(legacy);
    expect(readFileSync(path.join(home, "pg", "PG_VERSION"), "utf8")).toBe("18\n");
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    // Old absolute paths (worktrees, account logins) still resolve.
    expect(readFileSync(path.join(legacy, "pg", "PG_VERSION"), "utf8")).toBe("18\n");
    // Second start: nothing left to move.
    expect(moveLegacyHome(home, user)).toBeNull();
  });

  it("moves into a home that holds no database yet, old data first", () => {
    const user = userHome();
    mkdirSync(path.join(user, ".zastava", "pg"), { recursive: true });
    writeFileSync(path.join(user, ".zastava", "pg", "PG_VERSION"), "18\n");
    mkdirSync(path.join(user, ".zastava", "hub-plugins"));
    writeFileSync(path.join(user, ".zastava", "hub-plugins", "old"), "kept");
    const home = path.join(user, ".yugotool");
    mkdirSync(path.join(home, "hub-plugins"), { recursive: true });
    writeFileSync(path.join(home, "hub-plugins", "new"), "dropped");

    expect(moveLegacyHome(home, user)).toBe(path.join(user, ".zastava"));
    expect(readFileSync(path.join(home, "pg", "PG_VERSION"), "utf8")).toBe("18\n");
    expect(readFileSync(path.join(home, "hub-plugins", "old"), "utf8")).toBe("kept");
    expect(existsSync(path.join(home, "hub-plugins", "new"))).toBe(false);
    expect(lstatSync(path.join(user, ".zastava")).isSymbolicLink()).toBe(true);
  });

  it("leaves a fresh install, a home with a database and a custom home alone", () => {
    const user = userHome();
    expect(moveLegacyHome(path.join(user, ".yugotool"), user)).toBeNull();
    mkdirSync(path.join(user, ".zastava"));
    expect(moveLegacyHome(path.join(user, "elsewhere"), user)).toBeNull();
    mkdirSync(path.join(user, ".yugotool", "pg"), { recursive: true });
    writeFileSync(path.join(user, ".yugotool", "pg", "PG_VERSION"), "18\n");
    expect(moveLegacyHome(path.join(user, ".yugotool"), user)).toBeNull();
    expect(lstatSync(path.join(user, ".zastava")).isDirectory()).toBe(true);
  });

  it("refuses while the old app still runs from ~/.zastava", () => {
    const user = userHome();
    mkdirSync(path.join(user, ".zastava"));
    writeFileSync(
      path.join(user, ".zastava", "supervisor.json"),
      JSON.stringify({ pid: process.pid }),
    );
    expect(() => moveLegacyHome(path.join(user, ".yugotool"), user)).toThrow(/still running/);
    expect(existsSync(path.join(user, ".yugotool"))).toBe(false);
  });
});
