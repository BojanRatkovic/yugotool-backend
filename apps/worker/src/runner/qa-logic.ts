// Pure QA helpers: route derivation, judge prompt, verdict merge, builder report. No I/O.
import { z } from "zod";
import type {
  QaCheckKind,
  QaCheckStatus,
  QaPlan,
  QaStation,
  RouteMap,
  QaTheme,
  QaVerdict,
  QaViewport,
} from "@yugotool/contracts";

/** Visual checks per QA run are capped: each costs two screenshots per viewport×theme. */
export const MAX_ROUTES = 8;

const PAGE_EXT = /\.(tsx|ts|jsx|js|vue|svelte|astro|mdx|md)$/;

/**
 * Routes a diff probably touched, from file paths alone:
 * static `*.html`, Next (`pages/`, `app/**\/page.*`), SvelteKit (`+page.*`),
 * Nuxt/Astro `pages/`, TanStack/Remix `routes/`. Anything else → nothing;
 * `alwaysCheck` and the base URL cover the rest.
 */
export function deriveRoutes(files: string[]): string[] {
  return [...deriveRoutesWithFiles(files).keys()].toSorted();
}

/** Like deriveRoutes, with the first changed file behind each route. */
export function deriveRoutesWithFiles(files: string[]): Map<string, string> {
  const routes = new Map<string, string>();
  for (const raw of files) {
    const file = raw.trim().replace(/^\.\//, "");
    if (!file || file.includes("node_modules/")) continue;
    let route: string | null = null;

    if (file.endsWith(".html") && !file.includes("/")) {
      route = file === "index.html" ? "/" : `/${file}`;
    } else if (/(^|\/)public\/[^/]+\.html$/.test(file)) {
      const name = file.split("/").pop() ?? "";
      route = name === "index.html" ? "/" : `/${name}`;
    } else if (/(^|\/)app\/(.*\/)?page\.(tsx|ts|jsx|js|mdx)$/.test(file)) {
      route = `/${file.replace(/^.*?(^|\/)app\//, "").replace(/\/?page\.\w+$/, "")}`;
    } else if (/(^|\/)routes\/(.*\/)?\+page\.svelte$/.test(file)) {
      route = `/${file.replace(/^.*?(^|\/)routes\//, "").replace(/\/?\+page\.svelte$/, "")}`;
    } else if (/(^|\/)(pages|routes)\//.test(file) && PAGE_EXT.test(file)) {
      const rest = file.replace(/^.*?(^|\/)(pages|routes)\//, "").replace(PAGE_EXT, "");
      if (/(^|\/)(_app|_document|__root|_layout|layout|-components)(\/|$)/.test(rest)) continue;
      if (rest.split("/").some((part) => part.startsWith("-") || part.startsWith("_"))) continue;
      route = `/${rest.replace(/(^|\/)index$/, "").replace(/\./g, "/")}`;
    }
    if (route === null) continue;
    // Next/Nuxt route groups `(marketing)` and dynamic segments cannot be visited blindly.
    route = route.replace(/\/\([^/]+\)/g, "").replace(/\/+$/, "") || "/";
    if (/[[\]$]/.test(route)) continue;
    if (!routes.has(route)) routes.set(route, file);
  }
  return routes;
}

export interface PlannedScreen {
  name: string;
  path: string;
  /** Why QA looks at it; shown as "Why this screen". */
  reason: string;
}

export interface PlannedScenario {
  name: string;
  path: string;
  steps: string;
  reason: string;
}

export const PINNED_REASON = "Pinned route: checked on every run";

function pinnedScreens(station: QaStation): PlannedScreen[] {
  return station.alwaysCheck.map((c) => ({ name: c.name, path: c.path, reason: PINNED_REASON }));
}

/** Pinned routes first, then diff-derived routes, then "/" as a fallback. */
export function planScreens(station: QaStation, changedFiles: string[]): PlannedScreen[] {
  const screens = pinnedScreens(station);
  const seen = new Set(screens.map((s) => s.path));
  for (const [path, file] of deriveRoutesWithFiles(changedFiles).entries()) {
    if (seen.has(path)) continue;
    seen.add(path);
    screens.push({
      name: path === "/" ? "Home" : path,
      path,
      reason: `${file} changed and maps to this route`,
    });
  }
  if (screens.length === 0)
    screens.push({
      name: "Home",
      path: "/",
      reason: "No route could be derived from the changed files; the home page is the fallback",
    });
  return screens.slice(0, MAX_ROUTES);
}

/** The planner's screens are 2–6; pinned routes come on top. */
export const MAX_PLANNED_SCREENS = 6;
export const MAX_PLANNED_SCENARIOS = 6;

/** A visitable path: absolute, no unresolved `:param`/`*`/`[id]`, no origin. */
export function visitablePath(raw: string): string | null {
  const path = raw.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/(^|\/)(:|\*)|[[\]{}]|\s/.test(path)) return null;
  return path;
}

/**
 * Pinned routes + the planner's screens (deduped by path, unvisitable ones
 * dropped) and its scenarios. Null when the plan has no usable screen, so the
 * caller falls back to planScreens.
 */
export function mergePlan(
  station: QaStation,
  plan: QaPlan,
): { screens: PlannedScreen[]; scenarios: PlannedScenario[] } | null {
  const screens = pinnedScreens(station);
  const seen = new Set(screens.map((s) => s.path));
  let planned = 0;
  for (const screen of plan.screens) {
    const path = visitablePath(screen.path);
    if (!path || seen.has(path) || planned >= MAX_PLANNED_SCREENS) continue;
    seen.add(path);
    planned += 1;
    screens.push({
      name: screen.name.trim().slice(0, 80) || path,
      path,
      reason: screen.reason.trim().slice(0, 500) || "Picked by the planner",
    });
  }
  if (planned === 0) return null;
  const scenarios = plan.scenarios
    .map((s) => ({ ...s, path: visitablePath(s.path) ?? "/" }))
    .filter((s) => s.name.trim() && s.steps.trim())
    .slice(0, MAX_PLANNED_SCENARIOS)
    .map((s) => ({
      name: s.name.trim().slice(0, 80),
      path: s.path,
      steps: s.steps.trim().slice(0, 1_000),
      reason: s.reason.trim().slice(0, 500),
    }));
  return { screens: screens.slice(0, MAX_ROUTES), scenarios };
}

/** Diff text handed to the planner is capped; the stat always fits. */
export const MAX_PLANNER_DIFF_CHARS = 40_000;

/** Keeps whole file sections of a unified diff until the cap; notes what was cut. */
export function trimDiff(diff: string, maxChars = MAX_PLANNER_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  let kept = "";
  let dropped = 0;
  for (const section of sections) {
    if (kept.length + section.length > maxChars) {
      dropped += 1;
      continue;
    }
    kept += section;
  }
  return `${kept}\n… ${dropped} file diff${dropped === 1 ? "" : "s"} omitted (too long); see the stat above.`;
}

export function buildPlannerPrompt(input: {
  title: string;
  description: string;
  diffStat: string;
  diff: string;
  routeMap: RouteMap | null;
  pinned: { name: string; path: string }[];
  baseUrlPath: string;
  previousReport: string | null;
}): string {
  const routes = input.routeMap?.routes ?? [];
  const routeLines = routes.map(
    (r) =>
      `- ${r.title}: \`${r.path}\` → example \`${r.example}\`${r.description ? ` — ${r.description}` : ""}${r.components.length ? `\n  components: ${r.components.join(", ")}` : ""}`,
  );
  return [
    `# Plan QA for work order: ${input.title}`,
    input.description || "(no description)",
    input.previousReport
      ? `## The previous QA attempt failed with\n\n${input.previousReport}\n\nInclude the screens it complained about.`
      : "",
    `## Diff stat\n\n\`\`\`\n${input.diffStat.trim() || "(empty)"}\n\`\`\``,
    `## Diff\n\n\`\`\`diff\n${input.diff.trim() || "(empty)"}\n\`\`\``,
    routes.length
      ? `## Route map of the app\n\nPaths are relative to the app's base URL (${input.baseUrlPath}). Use the **example** URLs: their IDs exist in the preview's data.\n\n${routeLines.join("\n")}`
      : "## Route map\n\nNone yet. Find the routes yourself: read the router (Grep for the route definitions) and pick URLs that work with the app's mock data.",
    input.pinned.length
      ? `## Already checked on every run (do not repeat)\n\n${input.pinned.map((p) => `- ${p.name}: ${p.path}`).join("\n")}`
      : "",
    "## Your job",
    [
      "Decide which screens of the running app this change can affect, so QA can screenshot them on the base branch and on this branch and compare.",
      "1. For every changed component, hook, style or helper, find where it is rendered: Grep for its imports up to a route component in the route map. A shared component changes every screen that uses it — pick the 2–3 most representative ones.",
      `2. Return 2–${MAX_PLANNED_SCREENS} \`screens\`: concrete URLs (no \`:params\`, no origin), the most important first. \`reason\` = one sentence a reviewer reads: which changed file shows up on this screen and how (e.g. "TaskRow (src/components/task-row.tsx) renders every row of this list").`,
      "3. Return `scenarios` for changed states that have no URL of their own: a modal or drawer that opens on click, a dropdown, a hover card, an empty or error state, a form after submit. `path` = where to start, `steps` = plain-language clicks to reach the state, `reason` = why. Up to 6; none is fine when the change is visible on the screens alone.",
      "4. Read only what you need; do not edit anything. If nothing in the app can show the change (tests, docs, CI only), return the home screen with that reason.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "root"
  );
}

/** Unchanged below the threshold; `diffPct` is a percentage (0–100). */
export function visualStatus(diffPct: number, thresholdPct: number): "pass" | "changed" {
  return diffPct > thresholdPct ? "changed" : "pass";
}

/** Console errors that exist on the PR but not on base (messages compared without ports). */
// Covers a project host on *.localhost too (base and PR previews get different ports).
const normalizeMessage = (m: string): string =>
  m.replace(/\b((?:[a-z0-9-]+\.)*localhost):\d+/gi, "$1").trim();

export function newConsoleErrors(base: string[], pr: string[]): string[] {
  const known = new Set(base.map(normalizeMessage));
  return [...new Set(pr.filter((m) => !known.has(normalizeMessage(m))))];
}

export interface CheckForJudge {
  ref: string;
  name: string;
  kind: QaCheckKind;
  status: QaCheckStatus;
  path: string | null;
  viewport: QaViewport | null;
  theme: QaTheme | null;
  diffPct: number | null;
  note: string | null;
  reason: string | null;
  /** Absolute paths, for the judge's Read tool. */
  baseShot: string | null;
  prShot: string | null;
  diffShot: string | null;
}

export function buildJudgePrompt(input: {
  title: string;
  description: string;
  diffStat: string;
  checks: CheckForJudge[];
  prUrl: string;
  interactive: boolean;
  previousReport: string | null;
  /** The planner's states without a URL, with refs s1, s2, …; empty when none. */
  scenarios?: (PlannedScenario & { ref: string })[];
  /** False when the planner did not run or failed: the judge explores from "/". */
  planned?: boolean;
}): string {
  const scenarios = input.scenarios ?? [];
  const changed = input.checks.filter((c) => c.status !== "pass");
  const unchanged = input.checks.filter((c) => c.status === "pass");
  const line = (c: CheckForJudge): string => {
    const where = [c.path, c.viewport, c.theme].filter(Boolean).join(" · ");
    const pct = c.diffPct === null ? "" : ` · ${c.diffPct.toFixed(2)}% pixels changed`;
    const shots = [
      c.baseShot ? `  - base: ${c.baseShot}` : "",
      c.prShot ? `  - pr: ${c.prShot}` : "",
      c.diffShot ? `  - diff: ${c.diffShot}` : "",
    ].filter(Boolean);
    return [
      `- **${c.ref}** ${c.kind} "${c.name}" (${where}${pct}) — ${c.status}`,
      ...shots,
      c.reason ? `  - why QA looked: ${c.reason}` : "",
      c.note ? `  - ${c.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };
  return [
    `# QA for work order: ${input.title}`,
    input.description || "(no description)",
    input.previousReport
      ? `## The previous QA attempt failed with\n\n${input.previousReport}\n\nCheck first whether these are fixed.`
      : "",
    `## Diff stat\n\n\`\`\`\n${input.diffStat.trim() || "(empty)"}\n\`\`\``,
    "## What the line captured",
    "Each screen was screenshotted on the base branch and on this branch and pixel-diffed.",
    changed.length
      ? `### Changed (judge each one)\n\n${changed.map(line).join("\n")}`
      : "### Changed\n\nNo screen changed visually and no new console errors.",
    unchanged.length
      ? `### Unchanged\n\n${unchanged.map((c) => `- ${c.ref} ${c.name} (${[c.path, c.viewport, c.theme].filter(Boolean).join(" · ")})`).join("\n")}`
      : "",
    input.interactive && scenarios.length
      ? `## Scenarios to verify in the browser\n\nStates this change touches that have no URL of their own. Reach each one on ${input.prUrl}, screenshot it, and report it with its ref.\n\n${scenarios.map((s) => `- **${s.ref}** "${s.name}" — start at ${s.path}: ${s.steps}${s.reason ? `\n  - why: ${s.reason}` : ""}`).join("\n")}`
      : "",
    input.interactive && input.planned === false
      ? `## No plan\n\nNo screen plan was made for this change. Start at ${input.prUrl}/ and explore the parts of the app the diff touches.`
      : "",
    "## Your job",
    [
      "1. Open the base, pr and diff screenshots of every changed check with the Read tool and compare them. Do not open unchanged ones.",
      "2. Mark each changed check `intended` (the work order asked for it and it looks right) or `fail` (a regression, broken layout, overlap, cut-off text, an error, or the requested change looks wrong). Give a concrete reason in `note`.",
      input.interactive
        ? `3. The app on this branch runs at ${input.prUrl}. Use the browser tools to verify the work order's acceptance criteria ("Done when", or what the description asks for) like a QA engineer: open the page, click, type, submit. Take a screenshot (browser_take_screenshot) of each important state. Report each listed scenario with its ref (s1, s2, …) and any other scenario you checked with ref null; status pass or fail, and the path. Stay on ${input.prUrl}; other origins are blocked.`
        : "3. Do not use a browser; judge from the screenshots only.",
      "4. If the work order asked for a visible change and no screen changed, that is a `fail` (ref null) unless the change is not visible by nature.",
      "5. verdict is `fail` when any check is `fail` with severity critical or important; minor problems alone pass. Keep `summary` to 1–3 sentences.",
    ].join("\n"),
    "Report every changed check by its ref. Never edit files.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface CheckUpdate {
  ref: string;
  status: "pass" | "fail" | "intended";
  note: string;
  severity: "critical" | "important" | "minor" | null;
}

export interface NewCheck {
  /** The judge's ref when it is not a capture check, e.g. "s2" for a planned scenario. */
  ref: string | null;
  name: string;
  status: "pass" | "fail" | "intended";
  note: string;
  severity: "critical" | "important" | "minor" | null;
  path: string | null;
}

/** Splits the judge's checks into updates of known refs and new (scenario) checks. */
export function splitVerdict(
  verdict: QaVerdict,
  knownRefs: Set<string>,
): { updates: CheckUpdate[]; added: NewCheck[] } {
  const updates: CheckUpdate[] = [];
  const added: NewCheck[] = [];
  for (const check of verdict.checks) {
    const ref = check.ref?.trim() ?? null;
    // Severity describes a defect; judges sometimes grade intended changes too.
    const severity = check.status === "fail" ? (check.severity ?? "important") : null;
    if (ref && knownRefs.has(ref)) {
      updates.push({ ref, status: check.status, note: check.note, severity });
    } else {
      added.push({
        ref,
        name: check.name,
        status: check.status,
        note: check.note,
        severity,
        path: check.path,
      });
    }
  }
  return { updates, added };
}

/**
 * The judge decides, but a `fail` check of critical/important severity always
 * fails the run, so a "pass" verdict cannot hide a blocking defect.
 */
export function qaPassed(
  verdict: QaVerdict,
  checks: { status: QaCheckStatus; severity: string | null }[],
): boolean {
  if (verdict.verdict === "fail") return false;
  return !checks.some((c) => c.status === "fail" && c.severity !== "minor");
}

export interface ReportCheck {
  name: string;
  kind: QaCheckKind;
  status: QaCheckStatus;
  path: string | null;
  viewport: QaViewport | null;
  theme: QaTheme | null;
  note: string | null;
  severity: string | null;
  baseShot: string | null;
  prShot: string | null;
  diffShot: string | null;
}

/** Markdown the builder acts on: what is wrong, where, and the screenshots to look at. */
export function buildQaReport(summary: string, checks: ReportCheck[]): string {
  const failing = checks.filter((c) => c.status === "fail" || c.status === "error");
  const items = failing.map((c) => {
    const where = [c.path, c.viewport, c.theme].filter(Boolean).join(" · ");
    const shots = [
      c.baseShot ? `base \`${c.baseShot}\`` : "",
      c.prShot ? `this branch \`${c.prShot}\`` : "",
      c.diffShot ? `diff \`${c.diffShot}\`` : "",
    ].filter(Boolean);
    return [
      `- **${c.name}** (${c.kind}${where ? ` · ${where}` : ""}${c.severity ? ` · ${c.severity}` : ""}): ${c.note ?? "failed"}`,
      shots.length ? `  Screenshots (open them with Read): ${shots.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    `QA failed: ${summary}`,
    items.length ? `Failing checks:\n${items.join("\n")}` : "",
    "Fix these in the app, keep everything else as it is.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** `a:has-text("Team")` → `Team`; plain descriptions pass through. */
function readableTarget(target: string | null): string | null {
  if (!target) return null;
  const quoted = /(?:has-text|text|name)[=(]\s*["']([^"']+)["']/.exec(target);
  return quoted?.[1] ?? target;
}

const browserArgsSchema = z.record(z.string(), z.unknown()).catch({});

/**
 * Human label of a Playwright MCP call, used as the caption of the screenshot
 * that follows it. Null for calls that do not change what is on screen.
 */
export function browserActionLabel(tool: string, input: unknown, origin: string): string | null {
  const name = tool.replace(/^mcp__playwright__browser_/, "");
  if (name === tool) return null;
  const args = browserArgsSchema.parse(input);
  const text = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value ? value.slice(0, 80) : null;
  };
  const num = (key: string): string => {
    const value = args[key];
    return typeof value === "number" ? String(value) : "?";
  };
  const target = readableTarget(text("element") ?? text("target") ?? text("ref"));
  switch (name) {
    case "navigate": {
      const url = text("url");
      return url
        ? `Opened ${url.startsWith(origin) ? url.slice(origin.length) || "/" : url}`
        : "Opened page";
    }
    case "navigate_back":
      return "Went back";
    case "click":
      return target ? `Clicked ${target}` : "Clicked";
    case "type":
      return target ? `Typed into ${target}` : "Typed";
    case "fill_form":
      return "Filled the form";
    case "select_option":
      return target ? `Selected in ${target}` : "Selected an option";
    case "press_key":
      return `Pressed ${text("key") ?? "a key"}`;
    case "hover":
      return target ? `Hovered ${target}` : "Hovered";
    case "resize":
      return `Resized to ${num("width")}×${num("height")}`;
    default:
      return null;
  }
}

/** A screen whose pixels moved and that the judge found fine is "intended", not "pass". */
export function judgedStatus(
  before: QaCheckStatus,
  judged: "pass" | "fail" | "intended",
): "pass" | "fail" | "intended" {
  return judged === "pass" && before === "changed" ? "intended" : judged;
}
