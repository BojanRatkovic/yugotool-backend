import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFolderAccess, protectedFolders } from "../src/folders";
import { withoutClaudeSession } from "../src/services";

describe("protectedFolders", () => {
  const home = "/Users/ana";
  it("names the guarded folders that hold a path, once each, in a fixed order", () => {
    expect(
      protectedFolders(
        [
          "/Users/ana/Downloads/x",
          "/Users/ana/Desktop/Developer/a",
          "/Users/ana/Desktop/Developer/b",
          "/Users/ana/Desktop",
        ],
        home,
      ),
    ).toEqual(["/Users/ana/Desktop", "/Users/ana/Downloads"]);
  });

  it("ignores lookalikes and folders macOS does not guard", () => {
    expect(
      protectedFolders(["/Users/ana/Desktop-old/x", "/Users/ana/code/y", "/tmp/z"], home),
    ).toEqual([]);
  });
});

describe("checkFolderAccess", () => {
  it("grants a readable folder without saying it waits", async () => {
    let waited = false;
    const dir = mkdtempSync(path.join(tmpdir(), "zastava-folder-"));
    await expect(
      checkFolderAccess(dir, { onWaiting: () => (waited = true), waitingAfterMs: 5_000 }),
    ).resolves.toBe("granted");
    expect(waited).toBe(false);
  });

  it("does not report a missing folder as refused", async () => {
    await expect(checkFolderAccess("/nonexistent/zastava")).resolves.toBe("granted");
  });
});

describe("withoutClaudeSession", () => {
  it("drops a Claude Code session's markers and keeps the person's settings", () => {
    expect(
      withoutClaudeSession({
        CLAUDECODE: "1",
        CLAUDE_PID: "9540",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
        CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
        CLAUDE_AGENT_SDK_VERSION: "0.3.287",
        CLAUDE_CONFIG_DIR: "/Users/ana/.claude-work",
        CLAUDE_CODE_USE_BEDROCK: "1",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: "/Users/ana/.claude-work",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/usr/bin",
    });
  });
});
