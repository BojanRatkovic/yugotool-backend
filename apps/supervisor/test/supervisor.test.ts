import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pending, readMigrations } from "../src/migrate";
import { answersAs, firstFreePort, portFree } from "../src/services";
import { restartDelay } from "../src/supervisor";

describe("restartDelay", () => {
  const now = 1_000_000;
  it("backs off 1 s, 2 s, 4 s, 8 s", () => {
    expect(restartDelay([now], now)).toBe(1_000);
    expect(restartDelay([now - 10, now], now)).toBe(2_000);
    expect(restartDelay([now - 20, now - 10, now], now)).toBe(4_000);
    expect(restartDelay([now - 30, now - 20, now - 10, now], now)).toBe(8_000);
  });

  it("gives up at five crashes within two minutes", () => {
    expect(
      restartDelay(
        [1, 2, 3, 4, 5].map((n) => now - n),
        now,
      ),
    ).toBeNull();
  });

  it("forgets crashes older than the window", () => {
    const old = [now - 300_000, now - 290_000, now - 280_000, now - 270_000];
    expect(restartDelay([...old, now], now)).toBe(1_000);
  });
});

describe("migrations", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zastava-migrations-"));
  mkdirSync(path.join(dir, "meta"));
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      entries: [
        { idx: 1, when: 200, tag: "0001_b" },
        { idx: 0, when: 100, tag: "0000_a" },
      ],
    }),
  );
  writeFileSync(path.join(dir, "0000_a.sql"), "create table a (id int);");
  writeFileSync(
    path.join(dir, "0001_b.sql"),
    "alter table a add column x int;--> statement-breakpoint\nalter table a add column y int;",
  );

  it("reads the journal in order and splits statements", async () => {
    const all = await readMigrations(dir);
    expect(all.map((m) => m.tag)).toEqual(["0000_a", "0001_b"]);
    expect(all[1]?.statements).toEqual([
      "alter table a add column x int;",
      "alter table a add column y int;",
    ]);
    expect(all[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies only migrations newer than the last applied one", async () => {
    const all = await readMigrations(dir);
    expect(pending(all, null).map((m) => m.tag)).toEqual(["0000_a", "0001_b"]);
    expect(pending(all, 100).map((m) => m.tag)).toEqual(["0001_b"]);
    expect(pending(all, 200)).toEqual([]);
  });
});

const listen = (port: number, host?: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, ...(host ? { host } : {}) }, () => resolve(server));
  });
const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

const freeBase = async (): Promise<number> => {
  const server = await listen(0, "127.0.0.1");
  const address = server.address();
  await close(server);
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};

describe("ports", () => {
  it("sees a port taken on all interfaces (how the dev API listens) as busy", async () => {
    const port = await freeBase();
    const dev = await listen(port);
    expect(await portFree(port)).toBe(false);
    expect(await firstFreePort(port, port + 5, [port + 1])).toBe(port + 2);
    await close(dev);
    expect(await portFree(port)).toBe(true);
  });

  it("trusts a health endpoint only when it reports our pid", async () => {
    const port = await freeBase();
    const server = createHttpServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", pid: 4242 }));
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${port}/api/health`;
    expect(await answersAs(url, 4242)).toBe(true);
    expect(await answersAs(url, 1)).toBe(false);
    expect(await answersAs(url, null)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
