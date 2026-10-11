#!/usr/bin/env node
/**
 * Lays out what goes inside ZASTAVA.app for one CPU architecture:
 *
 *   .stage/<arch>/app        the app folder electron-builder packs
 *     package.json           manifest: name, version, main, pinned prod deps
 *     apps/{api,worker,supervisor,desktop}/dist   built JS
 *     packages/db/migrations  SQL the supervisor applies on start
 *     node_modules/          flat npm install for <arch> + @zastava/* copies
 *   .stage/<arch>/temporal   the `temporal` CLI for <arch> (extraResources → bin/)
 *
 * pnpm's symlinked store does not survive packing, so production deps are
 * reinstalled flat with npm, pinned to the versions pnpm resolved.
 *
 * Usage: node scripts/stage.mjs --arch arm64|x64   (after `pnpm build` in both repos)
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const TEMPORAL_CLI_VERSION = "1.8.2";

const { values } = parseArgs({ options: { arch: { type: "string", default: process.arch } } });
const arch = values.arch;
if (arch !== "arm64" && arch !== "x64") throw new Error(`unsupported arch ${arch}`);

const desktop = path.resolve(import.meta.dirname, "..");
const backend = path.resolve(desktop, "..", "..");
const frontendDist = path.resolve(backend, "..", "zastava-frontend", "dist");
const stage = path.join(desktop, ".stage", arch);
const app = path.join(stage, "app");

const sorted = (record) =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const step = (text) => console.log(`[stage ${arch}] ${text}`);

/** Run as entry points by path (supervisor spawns api + worker; Electron loads desktop). */
const APPS = ["api", "worker", "desktop"];
/**
 * Imported as @zastava/<name>; installed into node_modules from local copies.
 * Every `workspace:` dependency the apps reach, so a new package can't be left out.
 */
const PACKAGES = {};
{
  const workspace = new Map();
  for (const root of ["apps", "packages"]) {
    for (const name of readdirSync(path.join(backend, root))) {
      const file = path.join(backend, root, name, "package.json");
      if (existsSync(file)) workspace.set(readJson(file).name, { name, root, file });
    }
  }
  const queue = APPS.map((name) => path.join(backend, "apps", name, "package.json"));
  while (queue.length > 0) {
    const manifest = readJson(queue.pop());
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      const target = workspace.get(dep);
      if (!String(range).startsWith("workspace:") || !target || PACKAGES[target.name]) continue;
      PACKAGES[target.name] = target.root;
      queue.push(target.file);
    }
  }
}

// ── Preconditions ─────────────────────────────────────────────────────────────
for (const dir of [
  ...APPS.map((a) => path.join(backend, "apps", a, "dist")),
  ...Object.entries(PACKAGES).map(([p, root]) => path.join(backend, root, p, "dist")),
  path.join(frontendDist, "index.html"),
]) {
  if (!existsSync(dir)) throw new Error(`missing ${dir}: run pnpm build in both repos first`);
}

const local = path.join(stage, "local");
rmSync(app, { recursive: true, force: true });
rmSync(local, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// ── Built code ────────────────────────────────────────────────────────────────
step("copy built apps and packages");
for (const name of APPS) {
  const src = path.join(backend, "apps", name);
  cpSync(path.join(src, "dist"), path.join(app, "apps", name, "dist"), { recursive: true });
  if (name === "desktop")
    cpSync(path.join(src, "static"), path.join(app, "apps", name, "static"), { recursive: true });
}
cpSync(
  path.join(backend, "packages", "db", "migrations"),
  path.join(app, "packages", "db", "migrations"),
  {
    recursive: true,
  },
);

// Workspace packages: dist + a manifest without workspace:/dev entries, which
// npm installs as real folders (--install-links) and electron-builder then sees.
for (const [name, root] of Object.entries(PACKAGES)) {
  const src = path.join(backend, root, name);
  const dest = path.join(local, name);
  const manifest = readJson(path.join(src, "package.json"));
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(
      ([, range]) => !String(range).startsWith("workspace:"),
    ),
  );
  cpSync(path.join(src, "dist"), path.join(dest, "dist"), { recursive: true });
  writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify(
      { name: manifest.name, version: manifest.version, main: manifest.main, dependencies },
      null,
      2,
    ),
  );
}

// ── Manifest with pinned production deps ─────────────────────────────────────
step("resolve production dependencies");
const deps = {};
/** Platform packages (Postgres per CPU): optional, so npm keeps only this arch's. */
const optionalDeps = {};
const workspaceDirs = [
  ...APPS.map((a) => path.join(backend, "apps", a)),
  ...Object.entries(PACKAGES).map(([p, root]) => path.join(backend, root, p)),
];
for (const dir of workspaceDirs) {
  const manifest = readJson(path.join(dir, "package.json"));
  for (const [field, target] of [
    ["dependencies", deps],
    ["optionalDependencies", optionalDeps],
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith("workspace:")) continue;
      const installed = path.join(dir, "node_modules", name, "package.json");
      const version = existsSync(installed) ? readJson(installed).version : range;
      if (target[name] && target[name] !== version)
        step(`note: ${name} ${target[name]} vs ${version}, keeping the first`);
      target[name] ??= version;
    }
  }
}

const desktopManifest = readJson(path.join(desktop, "package.json"));
writeFileSync(
  path.join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "zastava",
      productName: "ZASTAVA",
      version: desktopManifest.version,
      description: "Software factory: work orders through a line of Claude Code agent stations.",
      author: "Bojan Ratković <ratkovicbojan94@gmail.com>",
      license: "UNLICENSED",
      private: true,
      main: "apps/desktop/dist/main.js",
      dependencies: sorted({
        ...deps,
        ...Object.fromEntries(
          Object.keys(PACKAGES).map((name) => [`@zastava/${name}`, `file:../local/${name}`]),
        ),
      }),
      optionalDependencies: sorted(optionalDeps),
    },
    null,
    2,
  )}\n`,
);

step(`npm install (darwin-${arch})`);
execFileSync(
  "npm",
  [
    "install",
    "--omit=dev",
    "--install-links",
    "--os=darwin",
    `--cpu=${arch}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ],
  { cwd: app, stdio: "inherit" },
);

// Temporal's native bridge ships every platform (~145 MB); keep this Mac's.
const bridgeReleases = path.join(app, "node_modules", "@temporalio", "core-bridge", "releases");
const bridgeTarget = arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
if (!existsSync(path.join(bridgeReleases, bridgeTarget)))
  throw new Error(`no Temporal bridge for ${bridgeTarget}`);
for (const target of readdirSync(bridgeReleases)) {
  if (target !== bridgeTarget)
    rmSync(path.join(bridgeReleases, target), { recursive: true, force: true });
}

// Postgres contrib modules: the schema uses none (gen_random_uuid is core). Keep
// what initdb and the server load themselves: PL/pgSQL, the text-search
// dictionaries, encoding conversions, replication output plugins.
const pgModules = path.join(
  app,
  "node_modules",
  "@embedded-postgres",
  `darwin-${arch}`,
  "native",
  "lib",
  "postgresql",
);
const keepPgModule = (file) =>
  /^(plpgsql|dict_snowball|libpqwalreceiver|pgoutput)\.dylib$|_and_/.test(file);
if (!existsSync(path.join(pgModules, "plpgsql.dylib")))
  throw new Error(`no plpgsql in ${pgModules}`);
for (const file of readdirSync(pgModules)) {
  if (!keepPgModule(file)) rmSync(path.join(pgModules, file), { recursive: true, force: true });
}

// ── Workflow bundle: the worker skips webpack at start-up ────────────────────
step("bundle workflows");
execFileSync(
  process.execPath,
  [
    path.join(backend, "apps", "worker", "scripts", "bundle-workflows.mjs"),
    path.join(app, "apps", "worker", "dist", "workflow-bundle.js"),
  ],
  { cwd: path.join(backend, "apps", "worker"), stdio: "inherit" },
);

// ── temporal CLI ──────────────────────────────────────────────────────────────
const temporal = path.join(stage, "temporal");
const cache = path.join(desktop, ".cache", `temporal-${TEMPORAL_CLI_VERSION}-${arch}`);
if (!existsSync(path.join(cache, "temporal"))) {
  step(`download temporal ${TEMPORAL_CLI_VERSION}`);
  mkdirSync(cache, { recursive: true });
  const url = `https://temporal.download/cli/archive/v${TEMPORAL_CLI_VERSION}?platform=darwin&arch=${arch === "x64" ? "amd64" : "arm64"}`;
  execFileSync("sh", ["-c", `curl -fsSL "${url}" | tar xz -C "${cache}" temporal`], {
    stdio: "inherit",
  });
}
mkdirSync(temporal, { recursive: true });
cpSync(path.join(cache, "temporal"), path.join(temporal, "temporal"));

step(`done → ${path.relative(desktop, stage)}`);
