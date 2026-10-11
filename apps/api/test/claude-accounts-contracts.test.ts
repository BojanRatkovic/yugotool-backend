import {
  claudeAccountLoginSchema,
  claudeAccountSchema,
  createClaudeAccountSchema,
  discoveredAccountSchema,
  settingsSchema,
  updateProjectSchema,
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

  it("creates from a config dir, a login or an API key", () => {
    expect(
      createClaudeAccountSchema.parse({ kind: "config_dir", configDir: "/u/.claude" }).kind,
    ).toBe("config_dir");
    expect(
      createClaudeAccountSchema.parse({ kind: "login", label: "Personal", email: "a@b.co" }).kind,
    ).toBe("login");
    expect(
      createClaudeAccountSchema.parse({ kind: "api_key", label: "Key", apiKey: " sk-ant-x " }),
    ).toMatchObject({ apiKey: "sk-ant-x" });
  });

  it("rejects a login without a label and an API key account without a key", () => {
    expect(createClaudeAccountSchema.safeParse({ kind: "login" }).success).toBe(false);
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
  });
});
