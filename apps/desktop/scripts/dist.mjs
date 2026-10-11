#!/usr/bin/env node
/**
 * Builds ad-hoc signed ZASTAVA.app + dmg per architecture into release/.
 * Usage: node scripts/dist.mjs [--arch arm64] [--arch x64] [--dir]
 *   --dir  app folder only (no dmg), quicker for local testing
 *
 * Developer ID signing, notarization and auto-update come later (0004 §8).
 * Until then a downloaded copy opens via System Settings → Privacy & Security
 * → Open Anyway. Ad-hoc, not unsigned: an unsigned arm64 Electron app keeps a
 * broken linker signature and macOS calls it "damaged".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Arch, build, Platform } from "electron-builder";

const { values } = parseArgs({
  options: {
    arch: { type: "string", multiple: true, default: [process.arch] },
    dir: { type: "boolean" },
  },
});
const desktop = path.resolve(import.meta.dirname, "..");
const frontendDist = path.resolve(desktop, "..", "..", "..", "zastava-frontend", "dist");
const electronVersion = JSON.parse(
  readFileSync(path.join(desktop, "node_modules", "electron", "package.json"), "utf8"),
).version;

// The stage is an npm install (package-lock.json, real folders). electron-builder
// picks its node_modules collector from npm_config_user_agent when the stage has
// no packageManager field, so `pnpm dist` would collect with pnpm, find nothing
// in the stage, and ship an app without api/worker deps. Pin it to npm.
process.env.npm_config_user_agent = "npm";
delete process.env.npm_execpath;

for (const arch of values.arch) {
  execFileSync(process.execPath, [path.join(desktop, "scripts", "stage.mjs"), "--arch", arch], {
    stdio: "inherit",
  });
  const stage = path.join(desktop, ".stage", arch);
  const artifacts = await build({
    targets: Platform.MAC.createTarget(
      values.dir ? ["dir"] : ["dmg"],
      arch === "x64" ? Arch.x64 : Arch.arm64,
    ),
    projectDir: desktop,
    config: {
      appId: "dev.zastava.desktop",
      productName: "ZASTAVA",
      copyright: "Copyright © 2026 Bojan Ratković",
      electronVersion,
      directories: {
        app: path.join(stage, "app"),
        output: path.join(desktop, "release"),
        buildResources: "build",
      },
      // Prebuilt, arch-correct node_modules come from stage.mjs; nothing to rebuild.
      npmRebuild: false,
      nodeGypRebuild: false,
      // Plain folder for now: postgres, temporal-bridge and the Claude binary
      // spawn from disk, and the worker reads its workflow bundle by path.
      asar: false,
      electronLanguages: ["en"],
      files: [
        "**/*",
        "!**/*.d.ts",
        "!**/*.d.ts.map",
        // Source maps: nothing runs with --enable-source-maps (~33 MB).
        "!**/*.{js,cjs,mjs}.map",
        "!**/{README,CHANGELOG,HISTORY}{,.md}",
        "!**/test{,s}/**",
      ],
      extraResources: [
        { from: frontendDist, to: "web" },
        { from: path.join(stage, "temporal", "temporal"), to: "bin/temporal" },
      ],
      mac: {
        category: "public.app-category.developer-tools",
        icon: "build/icon.icns",
        minimumSystemVersion: "12.0",
        darkModeSupport: true,
        // Ad-hoc; hardened runtime is only needed (and only works) with a Developer ID.
        identity: "-",
        hardenedRuntime: false,
        extendInfo: {
          NSHumanReadableCopyright: "Copyright © 2026 Bojan Ratković",
          LSApplicationCategoryType: "public.app-category.developer-tools",
        },
      },
      dmg: {
        title: "ZASTAVA ${version}",
        artifactName: "ZASTAVA-${version}-${arch}.dmg",
        contents: [
          { x: 150, y: 190, type: "file" },
          { x: 390, y: 190, type: "link", path: "/Applications" },
        ],
        window: { width: 540, height: 380 },
      },
    },
  });
  // LZMA (ULMO, macOS 10.15+) is about a quarter smaller than electron-builder's
  // zlib dmg, which its config does not offer. The dmg's blockmap would describe
  // the old bytes, so it goes; updates will diff zips, not dmgs.
  for (const dmg of artifacts.filter((file) => file.endsWith(".dmg"))) {
    const lzma = dmg.replace(/\.dmg$/, ".ulmo.dmg");
    rmSync(lzma, { force: true });
    execFileSync("hdiutil", ["convert", dmg, "-format", "ULMO", "-o", lzma, "-quiet"], {
      stdio: "inherit",
    });
    renameSync(lzma, dmg);
    rmSync(`${dmg}.blockmap`, { force: true });
  }
}
