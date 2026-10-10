import { describe, expect, it } from "vitest";
import {
  cleanPin,
  compareVersions,
  distName,
  type NodeRelease,
  resolveNodeVersion,
  withBinFirst,
} from "./node-versions";

const index: NodeRelease[] = [
  { version: "v25.1.0", lts: false },
  { version: "v24.11.0", lts: "Krypton" },
  { version: "v24.10.0", lts: false },
  { version: "v22.21.1", lts: "Jod" },
  { version: "v20.19.5", lts: "Iron" },
  { version: "v20.11.1", lts: "Iron" },
];

describe("Node pins (spec 0013)", () => {
  it("reads the first token of a pin file, ignoring comments", () => {
    expect(cleanPin("# team node\n  v20.11.1  \n")).toBe("v20.11.1");
    expect(cleanPin("lts/iron # keep in sync")).toBe("lts/iron");
    expect(cleanPin("\n\n")).toBeNull();
  });

  it("resolves pins the way nvm does", () => {
    expect(resolveNodeVersion("20", index)).toBe("v20.19.5");
    expect(resolveNodeVersion("v20.11", index)).toBe("v20.11.1");
    expect(resolveNodeVersion("20.11.1", index)).toBe("v20.11.1");
    expect(resolveNodeVersion("lts/*", index)).toBe("v24.11.0");
    expect(resolveNodeVersion("lts/iron", index)).toBe("v20.19.5");
    expect(resolveNodeVersion("node", index)).toBe("v25.1.0");
    expect(resolveNodeVersion("2", index)).toBeNull();
    expect(resolveNodeVersion(">=20", index)).toBeNull();
  });

  it("names tarballs, orders versions and puts the pinned bin first on PATH", () => {
    expect(distName("v24.11.0", "darwin", "arm64")).toBe("node-v24.11.0-darwin-arm64");
    expect(compareVersions("v20.9.0", "v20.11.0")).toBeLessThan(0);
    expect(withBinFirst({ PATH: "/usr/bin" }, "/n/bin").PATH).toBe("/n/bin:/usr/bin");
  });
});
