import { summarizeStorageState, storageStateSchema } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { BrowserTrace, hasState, redactUrl, type StorageState } from "./sign-in";

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

describe("redactUrl", () => {
  it("drops query strings and fragments", () => {
    expect(redactUrl("http://app.x.localhost:5100/login?token=secret#a")).toBe(
      "http://app.x.localhost:5100/login",
    );
    expect(redactUrl("https://api.example.com")).toBe("https://api.example.com/");
  });
});

describe("BrowserTrace", () => {
  it("flags a redirect loop once", () => {
    let now = 0;
    const trace = new BrowserTrace(() => now);
    for (let i = 0; i < 12; i++) {
      now += 1_000;
      trace.navigated(i % 2 ? "http://id.x.localhost/login?redirect=a" : "http://app.x.localhost/");
    }
    expect(trace.loopSuspected()).toBe(true);
    expect(trace.text().match(/redirect loop/g)).toHaveLength(1);
    expect(trace.text()).not.toContain("redirect=a");
  });

  it("does not flag a normal sign-in", () => {
    let now = 0;
    const trace = new BrowserTrace(() => now);
    for (const url of ["http://app/", "http://id/login", "http://app/acme"]) {
      now += 5_000;
      trace.navigated(url);
    }
    expect(trace.loopSuspected()).toBe(false);
  });
});
