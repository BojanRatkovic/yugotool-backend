import { describe, expect, it } from "vitest";
import { stripAnsi, withPinnedNode } from "./preview";

const NVM = "/home/me/.nvm/nvm.sh";

describe("withPinnedNode", () => {
  it("runs under the .nvmrc version when nvm is installed", () => {
    expect(withPinnedNode("npm ci", { nvmrc: true, nodeVersion: false }, NVM)).toBe(
      `. "${NVM}" && nvm use --silent && npm ci`,
    );
    expect(withPinnedNode("npm ci", { nvmrc: false, nodeVersion: true }, NVM)).toBe(
      `. "${NVM}" && nvm use --silent "$(cat .node-version)" && npm ci`,
    );
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
