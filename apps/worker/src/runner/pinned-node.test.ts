import { describe, expect, it } from "vitest";
import { previewSchema } from "@zastava/contracts";
import { previewOrigin, stripAnsi, withPinnedNode } from "./preview";

const NVM = "/home/me/.nvm/nvm.sh";

describe("withPinnedNode", () => {
  it("runs under the pinned version, installing it when missing", () => {
    expect(withPinnedNode("npm ci", { nvmrc: true, nodeVersion: false }, NVM)).toBe(
      `. "${NVM}" && nvm install --no-progress && {\nnpm ci\n}`,
    );
    expect(withPinnedNode("npm ci", { nvmrc: false, nodeVersion: true }, NVM)).toBe(
      `. "${NVM}" && nvm install --no-progress "$(cat .node-version)" && {\nnpm ci\n}`,
    );
  });

  it("pins every part of a compound command", () => {
    const command = withPinnedNode("a & b; c", { nvmrc: true, nodeVersion: false }, NVM);
    expect(command).toBe(`. "${NVM}" && nvm install --no-progress && {\na & b; c\n}`);
  });

  it("leaves the command alone otherwise", () => {
    expect(withPinnedNode("npm ci", { nvmrc: false, nodeVersion: false }, NVM)).toBe("npm ci");
    expect(withPinnedNode("npm ci", { nvmrc: true, nodeVersion: false }, null)).toBe("npm ci");
    const own = "source ~/.nvm/nvm.sh && nvm use && npm ci";
    expect(withPinnedNode(own, { nvmrc: true, nodeVersion: false }, NVM)).toBe(own);
  });
});

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
