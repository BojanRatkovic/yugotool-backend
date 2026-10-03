import { summarizeStorageState, storageStateSchema } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import { hasState, type StorageState } from "./sign-in";

const empty: StorageState = { cookies: [], origins: [] };
const cookie = (domain: string) =>
  ({
    name: "s",
    value: "v",
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  }) as const;

describe("hasState", () => {
  it("needs a cookie or some localStorage", () => {
    expect(hasState(empty)).toBe(false);
    expect(
      hasState({ cookies: [], origins: [{ origin: "http://a.localhost:1", localStorage: [] }] }),
    ).toBe(false);
    expect(hasState({ cookies: [cookie(".example.localhost")], origins: [] })).toBe(true);
    expect(
      hasState({
        cookies: [],
        origins: [{ origin: "http://a.localhost:1", localStorage: [{ name: "t", value: "1" }] }],
      }),
    ).toBe(true);
  });
});

describe("summarizeStorageState", () => {
  it("counts cookies and lists where the session applies", () => {
    const state = storageStateSchema.parse({
      cookies: [
        cookie(".example.localhost"),
        cookie("id.example.localhost"),
        cookie(".example.localhost"),
      ],
      origins: [
        { origin: "http://app.example.localhost:5100", localStorage: [{ name: "t", value: "1" }] },
        { origin: "http://unused.localhost:1", localStorage: [] },
      ],
    });
    expect(summarizeStorageState(state)).toEqual({
      cookieCount: 3,
      domains: ["app.example.localhost:5100", "example.localhost", "id.example.localhost"],
    });
  });
});
