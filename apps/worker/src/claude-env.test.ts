import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@zastava/db";
import { describe, expect, it } from "vitest";
import { authRejection, readApiKeyFrom, withApiKey } from "./claude-env";

/** Just enough of drizzle's select chain for the settings lookup. */
function settingsDb(key: string | null): Database {
  const chain = { from: () => chain, where: async () => [{ key }] };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stub of the one query used
  return { select: () => chain } as unknown as Database;
}

describe("withApiKey", () => {
  it("adds the saved key on top of the sandbox env", async () => {
    readApiKeyFrom(settingsDb("sk-ant-saved"));
    const options = await withApiKey({ env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-env" } });
    expect(options.env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-saved" });
  });

  it("leaves the options alone without a saved key", async () => {
    readApiKeyFrom(settingsDb(null));
    const options = { env: { PATH: "/bin" } };
    expect(await withApiKey(options)).toBe(options);
  });
});

const retry = (status: number | null) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields authRejection reads
  ({ type: "system", subtype: "api_retry", error_status: status }) as unknown as SDKMessage;

describe("authRejection", () => {
  it("stops on a rejected key with a pointer to Settings", () => {
    expect(authRejection(retry(401))).toContain("Settings → Claude access");
    expect(authRejection(retry(403))).toContain("403");
  });
  it("lets other retries run", () => {
    expect(authRejection(retry(529))).toBeNull();
    expect(authRejection(retry(null))).toBeNull();
  });
});
