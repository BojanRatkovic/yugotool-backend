import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveInside } from "../src/core/artifacts/artifacts";

describe("resolveInside", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "yugotool-artifacts-"));
    root = path.join(tmp, "run");
    outside = path.join(tmp, "secret.txt");
    await mkdir(path.join(root, "qa", "1"), { recursive: true });
    await writeFile(path.join(root, "qa", "1", "home-pr.png"), "png");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "qa", "link.png"));
  });

  it("resolves a file inside the root", async () => {
    expect(await resolveInside(root, "qa/1/home-pr.png")).toMatch(/qa\/1\/home-pr\.png$/);
  });

  it.each(["../secret.txt", "qa/../../secret.txt", "/etc/passwd", "", "qa/\0x"])(
    "rejects %j",
    async (rel) => {
      expect(await resolveInside(root, rel)).toBeNull();
    },
  );

  it("rejects a symlink that points outside", async () => {
    expect(await resolveInside(root, "qa/link.png")).toBeNull();
  });

  it("rejects missing files and the root itself", async () => {
    expect(await resolveInside(root, "qa/1/missing.png")).toBeNull();
    expect(await resolveInside(root, ".")).toBeNull();
  });
});
