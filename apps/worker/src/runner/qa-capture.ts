import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Preview, QA_VIEWPORTS, type QaTheme, type QaViewport } from "@yugotool/contracts";
import pixelmatch from "pixelmatch";
import { type Browser, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { previewUrl, withPorts } from "./preview";
import type { StorageState } from "./sign-in";

const exec = promisify(execFile);

/** Freezes animations and the caret so two captures of the same UI are pixel-equal. */
const STABILIZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`;
/** Masked in every capture: mark volatile UI (timestamps, avatars) with data-qa-mask. */
const MASK_SELECTOR = "[data-qa-mask]";
const NAV_TIMEOUT_MS = 30_000;
/** First load on a cold dev server (dependency optimizing, redirects) can be slow. */
const LOAD_TIMEOUT_MS = 90_000;
/** Dev servers that compile on first request (Vite optimizing deps, Ember) render late. */
const CONTENT_TIMEOUT_MS = 45_000;

export async function launchBrowser(onInstall?: (message: string) => void): Promise<Browser> {
  await ensureChromium(onInstall);
  return chromium.launch({ headless: true });
}

/** A browser window the user works in (preview sign-in). */
export async function launchVisibleBrowser(
  onInstall?: (message: string) => void,
): Promise<Browser> {
  await ensureChromium(onInstall);
  return chromium.launch({ headless: false });
}

let installingChromium: Promise<void> | null = null;

/**
 * Playwright's Chromium is fetched on first use (spec 0013), not set up by
 * hand: about 150 MB, once per Playwright version.
 */
export async function ensureChromium(onInstall?: (message: string) => void): Promise<void> {
  if (existsSync(chromium.executablePath())) return;
  onInstall?.("Installing Chromium for QA (first run, about 150 MB)…");
  installingChromium ??= (async () => {
    // "./cli" is not in playwright's exports; its package.json is, and cli.js sits next to it.
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    // Inside the desktop app process.execPath is Electron: run it as plain Node.
    const env = process.versions["electron"]
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env;
    await exec(process.execPath, [cli, "install", "chromium"], { env, timeout: 15 * 60_000 });
  })().finally(() => {
    installingChromium = null;
  });
  await installingChromium;
}

/** The Chromium binary Playwright installed; the judge's MCP browser uses the same one. */
export function chromiumPath(): string {
  return chromium.executablePath();
}

/**
 * The project's init snippet as a page script: `theme` in scope, `$PORT`/`$PORT2`
 * replaced with the preview's ports. Null when the project has none.
 */
export function initScript(
  preview: Preview,
  theme: QaTheme,
  ports: { port: number; port2: number },
): string | null {
  if (!preview.themeInit) return null;
  return `(function (theme) {\n${withPorts(preview.themeInit, ports)}\n})(${JSON.stringify(theme)});`;
}

export interface Capture {
  file: string;
  consoleErrors: string[];
  /** Set when the page could not be captured at all. */
  error: string | null;
}

/**
 * Screenshots one path at one viewport/theme. Fixed timezone, locale, reduced
 * motion and the stabilising stylesheet keep repeated captures identical.
 */
export async function capturePage(input: {
  browser: Browser;
  origin: string;
  preview: Preview;
  /** The preview's ports, for `$PORT`/`$PORT2` in the init script. */
  ports: { port: number; port2: number };
  path: string;
  viewport: QaViewport;
  theme: QaTheme;
  file: string;
  /** Saved sign-in, moved to this preview (sessionFor); null: signed out. */
  session?: StorageState | null;
}): Promise<Capture> {
  const size = QA_VIEWPORTS[input.viewport];
  const context = await input.browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    isMobile: input.viewport === "mobile",
    hasTouch: input.viewport === "mobile",
    colorScheme: input.theme,
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
    ...(input.session ? { storageState: input.session } : {}),
  });
  const consoleErrors: string[] = [];
  try {
    const init = initScript(input.preview, input.theme, input.ports);
    if (init) await context.addInitScript({ content: init });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on("pageerror", (err) => consoleErrors.push(`Uncaught: ${err.message}`.slice(0, 500)));
    page.on("requestfailed", (req) =>
      consoleErrors.push(`Request failed: ${req.url()} (${req.failure()?.errorText ?? "error"})`),
    );
    // "load" bounds the navigation; a quiet network and visible content are
    // waited for on top, without failing (dev servers compile on first hit).
    await page.goto(previewUrl(input.origin, input.preview, input.path), {
      waitUntil: "load",
      timeout: LOAD_TIMEOUT_MS,
    });
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    await waitForContent(page);
    await page.addStyleTag({ content: STABILIZE_CSS });
    await page.evaluate("document.fonts.ready");
    await mkdir(path.dirname(input.file), { recursive: true });
    await page.screenshot({
      path: input.file,
      fullPage: true,
      animations: "disabled",
      mask: [page.locator(MASK_SELECTOR)],
    });
    return { file: input.file, consoleErrors, error: null };
  } catch (error) {
    return {
      file: input.file,
      consoleErrors,
      error:
        error instanceof Error ? (error.message.split("\n")[0] ?? "capture failed") : String(error),
    };
  } finally {
    await context.close();
  }
}

/**
 * Waits until the page shows something (text or an image) and the network is
 * quiet again; a blank first paint is usually still compiling. Never throws:
 * a page that stays blank is captured blank.
 */
async function waitForContent(page: Page): Promise<void> {
  const shown = await page
    .waitForFunction(
      "document.body && (document.body.innerText.trim().length > 0 || document.images.length > 0)",
      null,
      { timeout: CONTENT_TIMEOUT_MS },
    )
    .then(() => true)
    .catch(() => false);
  if (shown)
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
}

/** Pads a PNG with transparent pixels to width×height (full-page shots differ in height). */
function padTo(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/**
 * Pixel diff of two screenshots; writes the diff image. Returns the changed
 * share of the larger canvas in percent (a size change alone counts as changed pixels).
 */
export async function diffImages(
  baseFile: string,
  prFile: string,
  diffFile: string,
): Promise<number> {
  const [baseRaw, prRaw] = await Promise.all([readFile(baseFile), readFile(prFile)]);
  const base = PNG.sync.read(baseRaw);
  const pr = PNG.sync.read(prRaw);
  const width = Math.max(base.width, pr.width);
  const height = Math.max(base.height, pr.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(
    padTo(base, width, height).data,
    padTo(pr, width, height).data,
    diff.data,
    width,
    height,
    // Captures are deterministic, so any colour change counts: the perceptual default
    // (0.1) missed a header tint #fafafb → #f5f3ff across 13% of the page.
    { threshold: 0, alpha: 0.35, includeAA: false },
  );
  await writeFile(diffFile, PNG.sync.write(diff));
  return (changed / (width * height)) * 100;
}
