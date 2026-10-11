import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRuntime,
  progressText,
  type RuntimeManifest,
  type RuntimeProgress,
  toolPath,
} from "../src/runtime";

/** A .tar.gz with `bin/tool` printing `version`, and its sha256 integrity. */
function archive(version: string): { bytes: Buffer; integrity: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "yugotool-archive-"));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "tool"), `#!/bin/sh\necho ${version}\n`);
  const file = path.join(dir, "out.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", file, "-C", dir, "bin/tool"]);
  const bytes = readFileSync(file);
  return { bytes, integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}` };
}

function manifest(version: string, integrity: string): RuntimeManifest {
  return {
    tools: [
      {
        name: "temporal",
        label: "Temporal",
        version,
        url: `https://example.test/temporal-${version}.tar.gz`,
        integrity,
        entry: "bin/tool",
      },
    ],
  };
}

/** A fetch that serves `bytes` in 4 chunks and counts its calls. */
function server(bytes: Buffer, status = 200): typeof fetch & { calls: number } {
  const fake = Object.assign(
    async () => {
      fake.calls += 1;
      const size = Math.ceil(bytes.length / 4);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += size)
            controller.enqueue(bytes.subarray(i, i + size));
          controller.close();
        },
      });
      return new Response(status === 200 ? body : null, {
        status,
        headers: { "content-length": String(bytes.length) },
      });
    },
    { calls: 0 },
  );
  return fake;
}

const home = (): string => mkdtempSync(path.join(tmpdir(), "yugotool-home-"));

describe("ensureRuntime", () => {
  it("fetches, checks and installs a tool, reporting progress up to the total", async () => {
    const dir = home();
    const { bytes, integrity } = archive("1.0");
    const fetchImpl = server(bytes);
    const seen: RuntimeProgress[] = [];
    const m = manifest("1.0", integrity);
    const fetched = await ensureRuntime(dir, m, {
      fetchImpl,
      onProgress: (progress) => seen.push({ ...progress }),
    });
    expect(fetched.map((tool) => tool.name)).toEqual(["temporal"]);
    const bin = toolPath(dir, m.tools[0]!);
    expect(execFileSync(bin, { encoding: "utf8" }).trim()).toBe("1.0");
    expect(seen.at(-1)).toEqual({ done: bytes.length, total: bytes.length });
    expect(readdirSync(path.join(dir, "runtime"))).toEqual(["temporal-1.0"]);
  });

  it("does not fetch what is already installed", async () => {
    const dir = home();
    const { bytes, integrity } = archive("1.0");
    await ensureRuntime(dir, manifest("1.0", integrity), { fetchImpl: server(bytes) });
    const again = server(bytes);
    expect(await ensureRuntime(dir, manifest("1.0", integrity), { fetchImpl: again })).toEqual([]);
    expect(again.calls).toBe(0);
  });

  it("refuses a download that fails its checksum and installs nothing", async () => {
    const dir = home();
    const { integrity } = archive("1.0");
    const { bytes: other } = archive("tampered");
    await expect(
      ensureRuntime(dir, manifest("1.0", integrity), { fetchImpl: server(other) }),
    ).rejects.toThrow(/corrupted/);
    expect(readdirSync(path.join(dir, "runtime"))).toEqual([]);
  });

  it("says which download failed on an HTTP error", async () => {
    const { bytes, integrity } = archive("1.0");
    await expect(
      ensureRuntime(home(), manifest("1.0", integrity), { fetchImpl: server(bytes, 404) }),
    ).rejects.toThrow("couldn't download Temporal: HTTP 404");
  });

  it("removes the previous version once the new one is in place", async () => {
    const dir = home();
    const old = archive("1.0");
    await ensureRuntime(dir, manifest("1.0", old.integrity), { fetchImpl: server(old.bytes) });
    const next = archive("2.0");
    await ensureRuntime(dir, manifest("2.0", next.integrity), { fetchImpl: server(next.bytes) });
    expect(readdirSync(path.join(dir, "runtime"))).toEqual(["temporal-2.0"]);
    expect(existsSync(path.join(dir, "runtime", "temporal-1.0"))).toBe(false);
  });
});

describe("progressText", () => {
  it("shows MB of the total, or MB alone without one", () => {
    expect(progressText({ done: 48 * 1_048_576, total: 139 * 1_048_576 })).toBe("48 of 139 MB");
    expect(progressText({ done: 5 * 1_048_576, total: null })).toBe("5 MB");
  });
});
