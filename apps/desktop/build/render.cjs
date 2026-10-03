// Renders icon.svg to PNGs and icon.icns (node render.cjs). Chromium from Playwright.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
void (async () => {
  const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, "icon.png"), omitBackground: true });
  await browser.close();
  const set = path.join(__dirname, "icon.iconset");
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync(
        "sips",
        [
          "-z",
          String(px),
          String(px),
          path.join(__dirname, "icon.png"),
          "--out",
          path.join(set, name),
        ],
        { stdio: "ignore" },
      );
    }
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(__dirname, "icon.icns")]);
  fs.rmSync(set, { recursive: true });
  console.log("icon.png + icon.icns");
})();
