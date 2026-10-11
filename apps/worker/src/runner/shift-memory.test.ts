import { describe, expect, it } from "vitest";
import { parseShiftTasks as parseTasks } from "@yugotool/contracts";

describe("parseTasks", () => {
  it("reads a bare array and a { tasks } object", () => {
    const tasks = [{ id: 1, title: "add", status: "done" }];
    expect(parseTasks(JSON.stringify(tasks))).toEqual([
      { id: "1", title: "add", status: "done", notes: null },
    ]);
    expect(parseTasks(JSON.stringify({ tasks }))).toHaveLength(1);
  });

  it("tolerates junk: bad JSON, unknown status, entries without a title", () => {
    expect(parseTasks("{nope")).toEqual([]);
    expect(parseTasks(null)).toEqual([]);
    expect(
      parseTasks(JSON.stringify([{ id: "a", title: "x", status: "blocked" }, { id: "b" }])),
    ).toEqual([{ id: "a", title: "x", status: "todo", notes: null }]);
  });
});
