import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { authRejection, resolveClaudeAuth, withClaudeAuth } from "./claude-env";

type Row = Parameters<typeof resolveClaudeAuth>[0]["project"] & {};

const row = (fields: Partial<Row>): Row => ({
  id: crypto.randomUUID(),
  label: "Account",
  kind: "config_dir",
  configDir: null,
  apiKey: null,
  email: null,
  orgName: null,
  subscriptionType: null,
  managed: false,
  createdAt: new Date(),
  ...fields,
});

const work = row({ configDir: "/u/.claude", email: "bojan@acme.io", subscriptionType: "team" });
const personal = row({
  configDir: "/u/.claude-personal",
  email: "me@example.com",
  subscriptionType: "max",
});
const ci = row({ kind: "api_key", label: "CI", apiKey: "sk-ant-ci" });
const env = {
  PATH: "/bin",
  ANTHROPIC_API_KEY: "sk-ant-env",
  CLAUDE_CONFIG_DIR: "/u/.claude-personal",
};

describe("resolveClaudeAuth (spec 0016)", () => {
  it("takes the project's account over the default", () => {
    const auth = resolveClaudeAuth(
      { project: work, fallback: personal, legacyKey: null },
      env,
      "/u",
    );
    expect(auth).toMatchObject({ configDir: "/u/.claude", label: "bojan@acme.io (team)" });
  });

  it("falls back to the default account", () => {
    const auth = resolveClaudeAuth(
      { project: null, fallback: personal, legacyKey: null },
      env,
      "/u",
    );
    expect(auth).toMatchObject({ configDir: "/u/.claude-personal", label: "me@example.com (max)" });
  });

  it("without accounts keeps the environment, its config dir included", () => {
    expect(
      resolveClaudeAuth({ project: null, fallback: null, legacyKey: null }, env, "/u"),
    ).toEqual({
      target: null,
      configDir: "/u/.claude-personal",
      label: null,
    });
    expect(
      resolveClaudeAuth({ project: null, fallback: null, legacyKey: null }, {}, "/u").configDir,
    ).toBe("/u/.claude");
  });

  it("names an API key account and keeps the env dir for plugins", () => {
    expect(
      resolveClaudeAuth({ project: ci, fallback: work, legacyKey: null }, env, "/u"),
    ).toMatchObject({
      target: { kind: "api_key", apiKey: "sk-ant-ci" },
      configDir: "/u/.claude-personal",
      label: "CI (API key)",
    });
  });
});

describe("withClaudeAuth", () => {
  it("a config dir account drops ANTHROPIC_API_KEY; ~/.claude runs with CLAUDE_CONFIG_DIR unset", () => {
    const home = (globalThis.process.env["HOME"] ?? "").replace(/\/+$/, "");
    const own = row({ configDir: `${home}/.claude`, email: "bojan@acme.io" });
    const auth = resolveClaudeAuth({ project: own, fallback: null, legacyKey: null }, env, home);
    expect(withClaudeAuth({ env }, auth).env).toEqual({ PATH: "/bin" });
    const other = resolveClaudeAuth(
      { project: personal, fallback: null, legacyKey: null },
      {},
      home,
    );
    expect(withClaudeAuth({ env: { PATH: "/bin", ANTHROPIC_API_KEY: "k" } }, other).env).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/u/.claude-personal",
    });
  });

  it("the key saved in Settings before accounts still wins over the env key", () => {
    const auth = resolveClaudeAuth(
      { project: null, fallback: null, legacyKey: "sk-ant-saved" },
      env,
      "/u",
    );
    expect(
      withClaudeAuth({ env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-env" } }, auth).env,
    ).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-saved",
    });
  });

  it("leaves the options alone without an account or a saved key", () => {
    const options = { env: { PATH: "/bin" } };
    const auth = resolveClaudeAuth({ project: null, fallback: null, legacyKey: null }, env, "/u");
    expect(withClaudeAuth(options, auth)).toBe(options);
  });
});

const retry = (status: number | null) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields authRejection reads
  ({ type: "system", subtype: "api_retry", error_status: status }) as unknown as SDKMessage;

describe("authRejection", () => {
  it("stops on a rejected key with a pointer to Settings", () => {
    expect(authRejection(retry(401))).toContain("Settings → Claude accounts");
    expect(authRejection(retry(403))).toContain("403");
  });
  it("lets other retries run", () => {
    expect(authRejection(retry(529))).toBeNull();
    expect(authRejection(retry(null))).toBeNull();
  });
});
