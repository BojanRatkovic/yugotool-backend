import { describe, expect, it } from "vitest";
import { existingPrUrl } from "./local-runner";

describe("existingPrUrl", () => {
  it("reads the url from gh's 'already exists' error", () => {
    const error = Object.assign(new Error("Command failed: gh pr create"), {
      stderr:
        'a pull request for branch "yugotool/x" into branch "master" already exists:\nhttps://github.com/acme/app/pull/1234\n',
    });
    expect(existingPrUrl(error)).toBe("https://github.com/acme/app/pull/1234");
  });

  it("returns null for other failures", () => {
    expect(existingPrUrl(new Error("HTTP 401: Bad credentials"))).toBeNull();
  });
});
