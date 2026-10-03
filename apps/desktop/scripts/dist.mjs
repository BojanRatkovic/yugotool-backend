#!/usr/bin/env node
/**
 * Builds unsigned ZASTAVA.app + dmg per architecture into release/.
 * Usage: node scripts/dist.mjs [--arch arm64] [--arch x64] [--dir]
 *   --dir  app folder only (no dmg), quicker for local testing
 *
 * Signing, notarization and auto-update come later (0004 §8): until then
 * Gatekeeper asks on first open (right-click → Open).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

for (const arch of values.arch) {
  execFileSync(process.execPath, [path.join(desktop, "scripts", "stage.mjs"), "--arch", arch], {
    stdio: "inherit",
  });
  const stage = path.join(desktop, ".stage", arch);
  await build({
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
        identity: null,
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
}
