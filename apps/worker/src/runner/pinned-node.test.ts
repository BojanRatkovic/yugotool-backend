import { describe, expect, it } from "vitest";
import { previewSchema } from "@yugotool/contracts";
import { previewOrigin, stripAnsi } from "./preview";

describe("stripAnsi", () => {
  it("removes colour and cursor codes, keeps the text", () => {
    expect(stripAnsi("\u001b[32m\u001b[1mVITE\u001b[22m v7.3.6\u001b[39m  ready")).toBe(
      "VITE v7.3.6  ready",
    );
  });
});

describe("previewOrigin", () => {
  const preview = previewSchema.parse({ start: "npm run dev" });

  it("opens on localhost unless the project sets a host", () => {
    expect(previewOrigin(preview, 5100)).toBe("http://localhost:5100");
    expect(previewOrigin({ ...preview, host: "app.example.localhost" }, 5100)).toBe(
      "http://app.example.localhost:5100",
    );
  });

  it("treats previews saved before the host field as localhost", () => {
    const { host: _host, ...saved } = preview;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a row saved before `host` existed
    expect(previewOrigin(saved as typeof preview, 5100)).toBe("http://localhost:5100");
  });
});
