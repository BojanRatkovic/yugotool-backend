import { describe, expect, it } from "vitest";
import { parseLsof, strayListeners } from "./orphans";

describe("parseLsof", () => {
  it("groups names by pid", () => {
    expect(parseLsof("p10\nf8\nn*:3000\nf9\nn[::1]:3000\np22\nf3\nn127.0.0.1:5173\n")).toEqual(
      new Map([
        [10, ["*:3000", "[::1]:3000"]],
        [22, ["127.0.0.1:5173"]],
      ]),
    );
  });
});

describe("strayListeners", () => {
  const roots = ["/w/run1", "/repo"];
  it("returns only new listeners started from the worktree or the main checkout", () => {
    const after = [
      { pid: 1, port: "3000", cwd: "/w/run1" },
      { pid: 2, port: "3001", cwd: "/repo/sub" },
      { pid: 3, port: "4810", cwd: "/zastava/api" },
      { pid: 4, port: "3002", cwd: "/w/run10" },
      { pid: 5, port: "3003", cwd: "/w/run1" },
      { pid: 6, port: "3004", cwd: null },
    ];
    expect(strayListeners(new Set([5]), after, roots).map((l) => l.pid)).toEqual([1, 2]);
  });
});
