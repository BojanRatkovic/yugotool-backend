import { summarizeStorageState, storageStateSchema } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import {
  BrowserTrace,
  hasState,
  parseSavedSession,
  landedOnSignIn,
  redactUrl,
  retargetSession,
  type SavedSession,
  type StorageState,
} from "./sign-in";

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
      storageKeys: 1,
      domains: ["app.example.localhost", "example.localhost", "id.example.localhost"],
    });
  });
});

const item = (name: string, value: string) => ({ name, value });

describe("parseSavedSession", () => {
  it("reads a session file and refuses anything else", () => {
    const file = {
      cookies: [cookie("localhost")],
      origins: [{ origin: "http://localhost:1", localStorage: [item("t", "1")] }],
      signedInOn: { host: "localhost", port: 1, port2: 2 },
    };
    expect(parseSavedSession(JSON.stringify(file))).toEqual(file);
    expect(parseSavedSession("{")).toBeNull();
    expect(parseSavedSession('{"cookies":[]}')).toBeNull();
  });
});

describe("retargetSession", () => {
  const saved: SavedSession = {
    cookies: [cookie("localhost")],
    origins: [
      {
        origin: "http://localhost:54432",
        localStorage: [
          item("ptm:auth@localhost-54433", '{"token":"t","api":"http://localhost:54433/api/v2"}'),
          item("visits", "54432"),
        ],
      },
      { origin: "https://other.example.com", localStorage: [item("k", "localhost:54432")] },
    ],
    signedInOn: { host: "localhost", port: 54432, port2: 54433 },
  };

  it("moves the app origin and its API mentions to the new ports", () => {
    const moved = retargetSession(saved, { host: "localhost", port: 52245, port2: 52246 });
    expect(moved).not.toHaveProperty("signedInOn");
    expect(moved.cookies).toEqual(saved.cookies);
    expect(moved.origins[0]).toEqual({
      origin: "http://localhost:52245",
      localStorage: [
        item("ptm:auth@localhost-52246", '{"token":"t","api":"http://localhost:52246/api/v2"}'),
        item("visits", "54432"),
      ],
    });
    // Other sites' origins stay; text inside them is only rewritten for this Mac's hosts.
    expect(moved.origins[1]).toEqual({
      origin: "https://other.example.com",
      localStorage: [item("k", "localhost:52245")],
    });
  });

  it("does not move a port twice when the ports swap", () => {
    const moved = retargetSession(saved, { host: "localhost", port: 54433, port2: 54432 });
    expect(moved.origins[0]?.origin).toBe("http://localhost:54433");
    expect(moved.origins[0]?.localStorage[0]?.name).toBe("ptm:auth@localhost-54432");
  });

  it("follows a changed preview host", () => {
    const moved = retargetSession(
      {
        ...saved,
        signedInOn: { host: "app.localhost", port: 5100, port2: -1 },
        origins: [
          {
            origin: "http://app.localhost:5100",
            localStorage: [item("u", "http://app.localhost:5100/x")],
          },
        ],
      },
      { host: "app.localhost", port: 6200, port2: 6201 },
    );
    expect(moved.origins).toEqual([
      {
        origin: "http://app.localhost:6200",
        localStorage: [item("u", "http://app.localhost:6200/x")],
      },
    ]);
  });

  it("infers where an older session was signed in", () => {
    const { signedInOn: _, ...legacy } = saved;
    const moved = retargetSession(legacy, { host: "localhost", port: 52245, port2: 52246 });
    expect(moved.origins[0]?.origin).toBe("http://localhost:52245");
    // The one other local port its storage mentions is the API's.
    expect(moved.origins[0]?.localStorage[0]).toEqual(
      item("ptm:auth@localhost-52246", '{"token":"t","api":"http://localhost:52246/api/v2"}'),
    );
    // Two candidates: the API port stays unknown.
    const ambiguous = {
      ...legacy,
      origins: [
        {
          origin: "http://localhost:54432",
          localStorage: [item("a@localhost-54433", "1"), item("b", "localhost:6000")],
        },
      ],
    };
    const kept = retargetSession(ambiguous, { host: "localhost", port: 52245, port2: 52246 });
    expect(kept.origins[0]).toEqual({ ...ambiguous.origins[0], origin: "http://localhost:52245" });
  });

  it("leaves the session alone when the ports match or the origin is ambiguous", () => {
    const same = retargetSession(saved, { host: "localhost", port: 54432, port2: 54433 });
    expect(same.origins).toEqual(saved.origins);
    const { signedInOn: _, ...legacy } = saved;
    const two = {
      ...legacy,
      origins: [
        ...legacy.origins,
        { origin: "http://localhost:6000", localStorage: [item("a", "1")] },
      ],
    };
    expect(retargetSession(two, { host: "localhost", port: 1, port2: 2 }).origins).toEqual(
      two.origins,
    );
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

describe("landedOnSignIn", () => {
  it("is true when the app sent the page to its sign-in screen", () => {
    expect(landedOnSignIn("/", "/login")).toBe(true);
    expect(landedOnSignIn("/1-acme/home", "/sign-in")).toBe(true);
    expect(landedOnSignIn("/", "/auth/login")).toBe(true);
  });

  it("is false when the page stayed in the app, or sign-in was what was asked for", () => {
    expect(landedOnSignIn("/", "/1-acme/home")).toBe(false);
    expect(landedOnSignIn("/login", "/login")).toBe(false);
    expect(landedOnSignIn("/", "/blog/logins-explained")).toBe(false);
    expect(landedOnSignIn("/", null)).toBe(false);
  });
});
