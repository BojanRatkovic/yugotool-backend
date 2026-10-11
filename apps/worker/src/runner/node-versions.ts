// Node versions repos pin (spec 0013): YugoTool downloads them itself into
// ~/.yugotool/node, so nothing like nvm has to be installed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { yugotoolHome } from "./home";

const exec = promisify(execFile);

const NODE_ROOT = path.join(yugotoolHome(), "node");
const DIST = "https://nodejs.org/dist";
/** The release index changes a few times a month. */
const INDEX_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface NodeRelease {
  /** "v24.1.0" */
  version: string;
  /** false, or the LTS codename ("Krypton"). */
  lts: string | false;
}

/** The pin a repo declares in `.nvmrc` or `.node-version`, else null. */
export async function readNodePin(dir: string): Promise<string | null> {
  for (const file of [".nvmrc", ".node-version"]) {
    const raw = await readFile(path.join(dir, file), "utf8").catch(() => null);
    const pin = raw === null ? null : cleanPin(raw);
    if (pin) return pin;
  }
  return null;
}

/** First non-comment token of a pin file. Pure. */
export function cleanPin(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const token = line.replace(/#.*/, "").trim();
    if (token) return token;
  }
  return null;
}

/**
 * The release a pin means, nvm-style: `20`, `v20.11`, `20.11.1`, `lts/*`,
 * `lts/iron`, `node`. `index` is newest first (nodejs.org/dist/index.json). Pure.
 */
export function resolveNodeVersion(pin: string, index: NodeRelease[]): string | null {
  const spec = pin.trim().toLowerCase().replace(/^v/, "");
  if (["node", "stable", "latest", "current"].includes(spec)) return index[0]?.version ?? null;
  if (spec.startsWith("lts/")) {
    const name = spec.slice(4);
    const match = index.find((r) =>
      name === "*" ? r.lts !== false : typeof r.lts === "string" && r.lts.toLowerCase() === name,
    );
    return match?.version ?? null;
  }
  if (!/^\d+(\.\d+){0,2}$/.test(spec)) return null;
  const match = index.find((r) => {
    const v = r.version.replace(/^v/, "");
    return v === spec || v.startsWith(`${spec}.`);
  });
  return match?.version ?? null;
}

/** `node-v24.1.0-darwin-arm64`, the folder name inside the release tarball. Pure. */
export function distName(
  version: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return `node-${version}-${platform}-${arch}`;
}

async function releaseIndex(): Promise<NodeRelease[]> {
  const cache = path.join(NODE_ROOT, "index.json");
  const fresh = await stat(cache).then(
    (s) => Date.now() - s.mtimeMs < INDEX_MAX_AGE_MS,
    () => false,
  );
  if (!fresh) {
    try {
      const res = await fetch(`${DIST}/index.json`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        await mkdir(NODE_ROOT, { recursive: true });
        await writeFile(cache, await res.text());
      }
    } catch {
      // Offline: an older cached index still resolves pins.
    }
  }
  const raw = await readFile(cache, "utf8").catch(() => "[]");
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.filter(
        (r): r is NodeRelease =>
          typeof r === "object" && r !== null && typeof Reflect.get(r, "version") === "string",
      )
    : [];
}

/** Versions already in ~/.yugotool/node, newest first. */
async function installedVersions(): Promise<string[]> {
  const entries = await readdir(NODE_ROOT).catch(() => [] as string[]);
  return entries
    .filter((e) => /^v\d+\.\d+\.\d+$/.test(e) && existsSync(path.join(NODE_ROOT, e, "bin", "node")))
    .toSorted((a, b) => compareVersions(b, a));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Downloads and unpacks one release (checksum-verified) into ~/.yugotool/node/<version>. */
async function install(version: string): Promise<void> {
  const name = distName(version);
  const tarball = `${name}.tar.gz`;
  const [archive, sums] = await Promise.all([
    fetch(`${DIST}/${version}/${tarball}`, { signal: AbortSignal.timeout(300_000) }),
    fetch(`${DIST}/${version}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archive.ok || !sums.ok) throw new Error(`Node ${version} is not published for this Mac`);
  const bytes = Buffer.from(await archive.arrayBuffer());
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.endsWith(`  ${tarball}`))
    ?.split(" ")[0];
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || expected !== actual) throw new Error(`Node ${version}: checksum mismatch`);
  await mkdir(NODE_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(NODE_ROOT, ".download-"));
  try {
    const file = path.join(work, tarball);
    await writeFile(file, bytes);
    await exec("tar", ["-xzf", file, "-C", work]);
    const target = path.join(NODE_ROOT, version);
    // Another run may have finished the same download meanwhile.
    if (!existsSync(target)) await rename(path.join(work, name), target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** One download per version at a time, even with several runs starting together. */
const installing = new Map<string, Promise<void>>();

/**
 * The bin folder of the Node a pin means, downloading it once. Offline, the
 * newest installed version that matches the pin. Null when nothing matches.
 */
export async function ensureNode(
  pin: string,
  onDownload?: (version: string) => void,
): Promise<{ version: string; binDir: string } | null> {
  const local = await installedVersions();
  const exact = /^v?\d+\.\d+\.\d+$/.test(pin.trim()) ? `v${pin.trim().replace(/^v/, "")}` : null;
  const version =
    (exact && local.includes(exact) ? exact : null) ??
    resolveNodeVersion(pin, await releaseIndex()) ??
    resolveNodeVersion(
      pin,
      local.map((v) => ({ version: v, lts: false })),
    );
  if (!version) return null;
  if (!local.includes(version)) {
    onDownload?.(version);
    let pending = installing.get(version);
    if (!pending) {
      pending = install(version).finally(() => installing.delete(version));
      installing.set(version, pending);
    }
    await pending;
  }
  return { version, binDir: path.join(NODE_ROOT, version, "bin") };
}

/** PATH with `binDir` first. Pure. */
export function withBinFirst(env: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
  return { ...env, PATH: [binDir, env["PATH"] ?? ""].filter(Boolean).join(path.delimiter) };
}

/**
 * `env` with the Node `dir` pins first on PATH; unchanged when it pins none or
 * the version can't be had. Best effort: a run never fails over this.
 */
const PNPM_ROOT = path.join(yugotoolHome(), "tools");

/** The exact pnpm a checkout pins in package.json's packageManager ("pnpm@12.4.1+sha512…"). */
export async function pinnedPnpm(dir: string): Promise<string | null> {
  try {
    const pkg: unknown = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    const value =
      typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "packageManager") : null;
    const match = typeof value === "string" ? /^pnpm@(\d[\w.-]*)/.exec(value) : null;
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const pnpmBin = (version: string): string =>
  path.join(PNPM_ROOT, `pnpm-${version}`, "node_modules", ".bin");

/**
 * The pinned pnpm, installed once with npm under ~/.yugotool/tools. A global
 * pnpm switches itself to the pinned version, but an older one cannot install
 * pnpm 12 (its native binary comes from a postinstall it skips): every pnpm
 * command in such a repo failed with "Failed to switch pnpm to v12.4.1".
 * npm runs the postinstall. Returns what happened, for Activity; null when
 * nothing was needed.
 */
export async function ensurePinnedPnpm(
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const version = await pinnedPnpm(dir);
  if (!version || existsSync(path.join(pnpmBin(version), "pnpm"))) return null;
  const prefix = path.join(PNPM_ROOT, `pnpm-${version}`);
  await mkdir(prefix, { recursive: true });
  try {
    await exec(
      "npm",
      ["install", "--prefix", prefix, "--no-audit", "--no-fund", `pnpm@${version}`],
      {
        env,
        timeout: 300_000,
      },
    );
    return `pnpm ${version} (pinned) installed for YugoTool's agents`;
  } catch (error) {
    await rm(prefix, { recursive: true, force: true });
    return `Could not install pnpm ${version} (pinned): ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** `env` with the pinned pnpm first on PATH, when YugoTool has it. */
async function withPinnedPnpm(dir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const version = await pinnedPnpm(dir);
  const bin = version ? pnpmBin(version) : null;
  return bin && existsSync(path.join(bin, "pnpm")) ? withBinFirst(env, bin) : env;
}

export async function pinnedNodeEnv(
  dir: string,
  env: NodeJS.ProcessEnv,
  log?: (message: string) => void,
): Promise<NodeJS.ProcessEnv> {
  return withPinnedPnpm(dir, await pinnedNodeOnly(dir, env, log));
}

async function pinnedNodeOnly(
  dir: string,
  env: NodeJS.ProcessEnv,
  log?: (message: string) => void,
): Promise<NodeJS.ProcessEnv> {
  const pin = await readNodePin(dir);
  if (!pin) return env;
  try {
    const node = await ensureNode(pin, (version) =>
      log?.(`Downloading Node ${version} (pinned "${pin}"), once`),
    );
    if (!node) {
      log?.(`Node "${pin}" (pinned) matches no release; using Node ${process.version}`);
      return env;
    }
    return withBinFirst(env, node.binDir);
  } catch (error) {
    log?.(
      `Could not get Node "${pin}" (${error instanceof Error ? error.message : String(error)}); using Node ${process.version}`,
    );
    return env;
  }
}
