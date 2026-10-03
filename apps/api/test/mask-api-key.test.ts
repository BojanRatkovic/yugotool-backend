import { describe, expect, it } from "vitest";
import { maskApiKey } from "../src/modules/settings/settings.service";

describe("maskApiKey", () => {
  it("keeps the key family and the last four characters", () => {
    expect(maskApiKey("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-x7Qd")).toBe(
      "sk-ant-api03-…x7Qd",
    );
  });

  it("never shows most of an unfamiliar or short key", () => {
    expect(maskApiKey("abcdefghijklmnopqrstuvwxyz")).toBe("abc…wxyz");
    expect(maskApiKey("short")).toBe("…rt");
  });
});
