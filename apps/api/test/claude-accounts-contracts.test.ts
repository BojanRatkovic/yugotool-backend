import {
  claudeAccountLoginSchema,
  claudeAccountSchema,
  createClaudeAccountSchema,
  discoveredAccountSchema,
  claudeAccountEnv,
  settingsSchema,
  startClaudeLoginSchema,
  updateProjectSchema,
  updateSettingsSchema,
} from "@zastava/contracts";
import { describe, expect, it } from "vitest";

const ID = "0199d0a4-0000-7000-8000-000000000001";

describe("Claude account contracts (spec 0016)", () => {
  it("parses an account and never carries the key", () => {
    const account = claudeAccountSchema.parse({
      id: ID,
      label: "Work",
      kind: "api_key",
      configDir: null,
      apiKeyHint: "sk-ant-…x7Qd",
      email: null,
      orgName: null,
      subscriptionType: null,
      managed: false,
      isDefault: true,
      status: "signed_in",
      createdAt: "2026-10-11T12:00:00.000Z",
      apiKey: "sk-ant-secret",
    });
    expect(account).not.toHaveProperty("apiKey");
  });

  it("creates from a config dir or an API key; logins start elsewhere", () => {
    expect(
      createClaudeAccountSchema.parse({ kind: "config_dir", configDir: "/u/.claude" }).kind,
    ).toBe("config_dir");
    expect(createClaudeAccountSchema.safeParse({ kind: "login", label: "Personal" }).success).toBe(
      false,
    );
    expect(startClaudeLoginSchema.parse({ label: "Personal", email: "a@b.co" })).toEqual({
      label: "Personal",
      email: "a@b.co",
    });
    expect(
      createClaudeAccountSchema.parse({ kind: "api_key", label: "Key", apiKey: " sk-ant-x " }),
    ).toMatchObject({ apiKey: "sk-ant-x" });
  });

  it("rejects a config dir account without a dir and an API key account without a key", () => {
    expect(createClaudeAccountSchema.safeParse({ kind: "config_dir" }).success).toBe(false);
    expect(createClaudeAccountSchema.safeParse({ kind: "api_key", label: "Key" }).success).toBe(
      false,
    );
    expect(createClaudeAccountSchema.safeParse({ kind: "oauth", label: "x" }).success).toBe(false);
  });

  it("parses a pending login with its manual link", () => {
    const login = claudeAccountLoginSchema.parse({
      id: "l1",
      accountId: null,
      state: "pending",
      url: "https://claude.com/cai/oauth/authorize?code=true",
      error: null,
    });
    expect(login.state).toBe("pending");
    expect(claudeAccountLoginSchema.safeParse({ ...login, state: "waiting" }).success).toBe(false);
  });

  it("parses a discovered dir that is not added yet", () => {
    const found = discoveredAccountSchema.parse({
      configDir: "/u/.claude-personal",
      loggedIn: true,
      email: "me@example.com",
      orgName: null,
      subscriptionType: "max",
      accountId: null,
    });
    expect(found.accountId).toBeNull();
  });

  it("lets a project clear its account and settings name no default", () => {
    expect(updateProjectSchema.parse({ claudeAccountId: null })).toEqual({ claudeAccountId: null });
    expect(updateProjectSchema.safeParse({ claudeAccountId: "nope" }).success).toBe(false);
    expect(settingsSchema.shape.defaultClaudeAccountId.parse(null)).toBeNull();
    // The default goes through PUT /claude-accounts/default, which checks the account.
    expect(updateSettingsSchema.parse({ defaultClaudeAccountId: ID })).toEqual({});
  });
});

const dir = (configDir: string) => ({ kind: "config_dir" as const, configDir, apiKey: null });

describe("claudeAccountEnv (spec 0016)", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-env",
    CLAUDE_CONFIG_DIR: "/u/.claude-personal",
  };

  it("leaves the environment alone without an account", () => {
    expect(claudeAccountEnv(base, null, "/u")).toBe(base);
  });

  it("points a config dir account at its dir and drops the env API key", () => {
    expect(claudeAccountEnv(base, dir("/u/.zastava/accounts/a/"), "/u")).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/u/.zastava/accounts/a",
    });
  });

  it("runs ~/.claude with CLAUDE_CONFIG_DIR unset", () => {
    expect(claudeAccountEnv(base, dir("/u/.claude/"), "/u/")).toEqual({ PATH: "/bin" });
  });

  it("sets an API key account's key", () => {
    expect(
      claudeAccountEnv(base, { kind: "api_key", configDir: null, apiKey: "sk-acct" }, "/u"),
    ).toMatchObject({ ANTHROPIC_API_KEY: "sk-acct" });
  });
});
