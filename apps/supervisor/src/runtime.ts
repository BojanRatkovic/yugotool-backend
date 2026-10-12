import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * Binaries the packaged app fetches on first start instead of shipping them
 * (spec 0017). `scripts/stage.mjs` writes this as `runtime.json`.
 */
const runtimeToolSchema = z.object({
  name: z.enum(["claude", "temporal"]),
  /** For people: "Claude Code". */
  label: z.string(),
  version: z.string(),
  /** A .tar.gz. */
  url: z.url(),
  /** Subresource-integrity style: "sha512-<base64>" (npm) or "sha256-<base64>". */
  integrity: z.string().regex(/^sha(256|512)-[A-Za-z0-9+/]+=*$/),
  /** The executable's path inside the archive. */
  entry: z.string(),
});
const runtimeManifestSchema = z.object({ tools: z.array(runtimeToolSchema).min(1) });
export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;
export type RuntimeTool = z.infer<typeof runtimeToolSchema>;
export type ToolName = RuntimeTool["name"];

export interface RuntimeProgress {
  /** Bytes fetched so far, across every tool being fetched. */
  done: number;
  /** null while a server sends no Content-Length. */
  total: number | null;
}

export function readRuntimeManifest(file: string): RuntimeManifest {
  return runtimeManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const runtimeDir = (home: string): string => path.join(home, "runtime");
const toolDir = (home: string, tool: RuntimeTool): string =>
  path.join(runtimeDir(home), `${tool.name}-${tool.version}`);

/** Where a tool's executable lives once fetched; it may not exist yet. */
export function toolPath(home: string, tool: RuntimeTool): string {
  return path.join(toolDir(home, tool), path.basename(tool.entry));
}

export function findTool(manifest: RuntimeManifest, name: ToolName): RuntimeTool | null {
  return manifest.tools.find((tool) => tool.name === name) ?? null;
}

/** A tool's folder only appears by rename once complete, so the file is enough. */
const toolInstalled = (home: string, tool: RuntimeTool): boolean =>
  existsSync(toolPath(home, tool));

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

/** "48 of 139 MB", "48 MB" without a total. Pure. */
export function progressText(progress: RuntimeProgress): string {
  return progress.total
    ? `${mb(progress.done)} of ${mb(progress.total)} MB`
    : `${mb(progress.done)} MB`;
}

/** Throws unless `digest` matches an SRI-style integrity string. Pure. */
function checkIntegrity(integrity: string, digest: Buffer, label: string): void {
  const [algorithm, expected] = integrity.split("-", 2);
  if (digest.toString("base64") !== expected) {
    throw new Error(`${label} download is corrupted (${algorithm} mismatch); try again`);
  }
}

/**
 * Fetches every tool that is not installed yet into
 * `<home>/runtime/<name>-<version>/`, verified against its checksum, and
 * removes other versions of the same tools. Returns the tools it fetched.
 */
export async function ensureRuntime(
  home: string,
  manifest: RuntimeManifest,
  options: {
    onProgress?: (progress: RuntimeProgress, fetching: RuntimeTool[]) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<RuntimeTool[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const missing = manifest.tools.filter((tool) => !toolInstalled(home, tool));
  await mkdir(runtimeDir(home), { recursive: true });
  if (missing.length > 0) {
    // Start every request first so the total is known before the bar moves.
    const responses = await Promise.all(
      missing.map(async (tool) => {
        const response = await fetchImpl(
          tool.url,
          options.signal ? { signal: options.signal } : {},
        ).catch((error: unknown) => {
          throw new Error(
            `couldn't download ${tool.label}. Check the internet connection and try again (${reason(error)})`,
          );
        });
        if (!response.ok || !response.body) {
          throw new Error(`couldn't download ${tool.label}: HTTP ${response.status}`);
        }
        return { tool, response };
      }),
    );
    const sizes = responses.map(({ response }) => Number(response.headers.get("content-length")));
    const total = sizes.every((size) => size > 0) ? sizes.reduce((a, b) => a + b, 0) : null;
    let done = 0;
    // In parallel: a body left waiting behind a 100 MB one would hit undici's body timeout.
    await Promise.all(
      responses.map(({ tool, response }) =>
        install(home, tool, response, (bytes) => {
          done += bytes;
          options.onProgress?.({ done, total }, missing);
        }),
      ),
    );
  }
  await prune(home, manifest);
  return missing;
}

/** Download → checksum → unpack into a temp dir → rename into place. */
async function install(
  home: string,
  tool: RuntimeTool,
  response: Response,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const scratch = await mkdtemp(path.join(runtimeDir(home), `.tmp-${tool.name}-`));
  try {
    const archive = path.join(scratch, "archive.tar.gz");
    const hash = createHash(tool.integrity.startsWith("sha512-") ? "sha512" : "sha256");
    if (!response.body) throw new Error(`couldn't download ${tool.label}: empty response`);
    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      onBytes(chunk.length);
    });
    await pipeline(body, createWriteStream(archive)).catch((error: unknown) => {
      throw new Error(`couldn't download ${tool.label}: ${reason(error)}; try again`);
    });
    checkIntegrity(tool.integrity, hash.digest(), tool.label);

    const unpacked = path.join(scratch, "unpacked");
    await mkdir(unpacked);
    await execFileAsync("/usr/bin/tar", ["-xzf", archive, "-C", unpacked, tool.entry]);
    const staged = path.join(scratch, "tool");
    await mkdir(staged);
    const executable = path.join(staged, path.basename(tool.entry));
    await rename(path.join(unpacked, tool.entry), executable);
    await chmod(executable, 0o755);

    const target = toolDir(home, tool);
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Other versions of the manifest's tools and leftovers of cut-off downloads. */
async function prune(home: string, manifest: RuntimeManifest): Promise<void> {
  const keep = new Set(manifest.tools.map((tool) => path.basename(toolDir(home, tool))));
  const names = new Set(manifest.tools.map((tool) => tool.name));
  for (const entry of await readdir(runtimeDir(home))) {
    const stale =
      entry.startsWith(".tmp-") ||
      (!keep.has(entry) && [...names].some((name) => entry.startsWith(`${name}-`)));
    if (stale) await rm(path.join(runtimeDir(home), entry), { recursive: true, force: true });
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : null;
    return cause ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}
