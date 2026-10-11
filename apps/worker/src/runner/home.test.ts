import { describe, expect, it } from "vitest";
import { yugotoolHome } from "./home";

describe("yugotoolHome", () => {
  it("is YUGOTOOL_HOME when set, else ~/.yugotool", () => {
    expect(yugotoolHome("/Users/ana", {})).toBe("/Users/ana/.yugotool");
    expect(yugotoolHome("/Users/ana", { YUGOTOOL_HOME: "/tmp/demo/home" })).toBe("/tmp/demo/home");
  });
});
