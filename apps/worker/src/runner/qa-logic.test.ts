import { QA_STATION_TEMPLATE, type QaVerdict } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import {
  browserActionLabel,
  buildJudgePrompt,
  buildQaReport,
  deriveRoutes,
  judgedStatus,
  MAX_PLANNED_SCREENS,
  MAX_ROUTES,
  mergePlan,
  newConsoleErrors,
  PINNED_REASON,
  planScreens,
  qaPassed,
  buildPlannerPrompt,
  splitVerdict,
  trimDiff,
  visitablePath,
  visualStatus,
} from "./qa-logic";

describe("deriveRoutes", () => {
  it("maps static html, Next, SvelteKit and file routes", () => {
    expect(
      deriveRoutes([
        "index.html",
        "about.html",
        "app/settings/page.tsx",
        "app/(marketing)/pricing/page.tsx",
        "src/routes/blog/+page.svelte",
        "src/pages/team/index.tsx",
        "src/app/routes/projects.$projectId.tsx",
      ]),
    ).toEqual(["/", "/about.html", "/blog", "/pricing", "/settings", "/team"]);
  });

  it("ignores layouts, private files, dynamic segments and non-page files", () => {
    expect(
      deriveRoutes([
        "pages/_app.tsx",
        "src/routes/__root.tsx",
        "src/app/routes/-components/panel.tsx",
        "app/users/[id]/page.tsx",
        "src/lib/format.ts",
        "server.js",
        "node_modules/x/index.html",
        "styles.css",
      ]),
    ).toEqual([]);
  });
});

describe("planScreens", () => {
  it("puts alwaysCheck first, dedupes, and falls back to home", () => {
    const station = { ...QA_STATION_TEMPLATE, alwaysCheck: [{ name: "Landing", path: "/" }] };
    expect(planScreens(station, ["index.html", "about.html"])).toEqual([
      { name: "Landing", path: "/", reason: PINNED_REASON },
      {
        name: "/about.html",
        path: "/about.html",
        reason: "about.html changed and maps to this route",
      },
    ]);
    expect(planScreens(QA_STATION_TEMPLATE, ["server.js"])).toEqual([
      { name: "Home", path: "/", reason: expect.stringContaining("fallback") },
    ]);
  });

  it("caps the number of screens", () => {
    const files = Array.from({ length: 20 }, (_, i) => `page${i}.html`);
    expect(planScreens(QA_STATION_TEMPLATE, files)).toHaveLength(MAX_ROUTES);
  });
});

describe("visualStatus", () => {
  it("is changed only above the threshold", () => {
    expect(visualStatus(0.1, 0.1)).toBe("pass");
    expect(visualStatus(0.11, 0.1)).toBe("changed");
    expect(visualStatus(0, 0)).toBe("pass");
  });
});

describe("newConsoleErrors", () => {
  it("keeps only errors new on the PR, ignoring the port", () => {
    expect(
      newConsoleErrors(
        ["Request failed: http://localhost:5100/a.js (net::ERR)"],
        [
          "Request failed: http://localhost:6200/a.js (net::ERR)",
          "Uncaught: x is not defined",
          "Uncaught: x is not defined",
        ],
      ),
    ).toEqual(["Uncaught: x is not defined"]);
  });
});

const verdict = (over: Partial<QaVerdict> = {}): QaVerdict => ({
  verdict: "pass",
  summary: "ok",
  checks: [],
  ...over,
});

describe("splitVerdict", () => {
  it("updates known refs and adds the rest as new checks", () => {
    const result = splitVerdict(
      verdict({
        checks: [
          {
            ref: "c1",
            name: "Home",
            status: "intended",
            severity: null,
            note: "heading",
            path: "/",
          },
          { ref: "c9", name: "Ghost", status: "fail", severity: "minor", note: "?", path: null },
          {
            ref: null,
            name: "Empty email",
            status: "fail",
            severity: "critical",
            note: "no error",
            path: "/",
          },
        ],
      }),
      new Set(["c1", "c2"]),
    );
    expect(result.updates).toEqual([
      { ref: "c1", status: "intended", note: "heading", severity: null },
    ]);
    expect(result.added.map((a) => a.name)).toEqual(["Ghost", "Empty email"]);
    expect(result.added.map((a) => a.severity)).toEqual(["minor", "critical"]);
  });
});

describe("qaPassed", () => {
  it("fails on a fail verdict or any non-minor failing check", () => {
    expect(qaPassed(verdict(), [{ status: "intended", severity: null }])).toBe(true);
    expect(qaPassed(verdict(), [{ status: "fail", severity: "minor" }])).toBe(true);
    expect(qaPassed(verdict(), [{ status: "fail", severity: "important" }])).toBe(false);
    expect(qaPassed(verdict(), [{ status: "fail", severity: null }])).toBe(false);
    expect(qaPassed(verdict({ verdict: "fail" }), [])).toBe(false);
  });
});

describe("prompts and reports", () => {
  const check = {
    ref: "c1",
    name: "Home",
    kind: "visual" as const,
    status: "changed" as const,
    path: "/",
    viewport: "mobile" as const,
    theme: "light" as const,
    diffPct: 4.2,
    note: null,
    reason: "TaskRow renders this list",
    baseShot: "/a/base.png",
    prShot: "/a/pr.png",
    diffShot: "/a/diff.png",
  };

  it("lists changed checks with absolute shots and the browser instruction", () => {
    const prompt = buildJudgePrompt({
      title: "Change heading",
      description: "Done when the heading says Hi",
      diffStat: " index.html | 2 +-",
      checks: [check, { ...check, ref: "c2", status: "pass", diffPct: 0 }],
      prUrl: "http://localhost:5555",
      interactive: true,
      previousReport: null,
    });
    expect(prompt).toContain('**c1** visual "Home" (/ · mobile · light · 4.20% pixels changed)');
    expect(prompt).toContain("diff: /a/diff.png");
    expect(prompt).toContain("http://localhost:5555");
    expect(prompt).toMatch(/### Unchanged\n\n- c2 Home/);
    expect(prompt).toContain("why QA looked: TaskRow renders this list");
    expect(prompt).not.toContain("## Scenarios");
  });

  it("lists planned scenarios with refs, or tells the judge to explore without a plan", () => {
    const base = {
      title: "t",
      description: "",
      diffStat: "",
      checks: [check],
      prUrl: "http://localhost:5555",
      interactive: true,
      previousReport: null,
    };
    const withScenario = buildJudgePrompt({
      ...base,
      planned: true,
      scenarios: [
        { ref: "s1", name: "Delete dialog", path: "/tasks", steps: "Click Delete", reason: "r" },
      ],
    });
    expect(withScenario).toContain('**s1** "Delete dialog" — start at /tasks: Click Delete');
    expect(withScenario).not.toContain("## No plan");
    expect(buildJudgePrompt({ ...base, planned: false })).toContain("## No plan");
  });

  it("builds a builder report from failing checks only", () => {
    const report = buildQaReport("layout broken", [
      { ...check, status: "fail", note: "button overflows", severity: "critical" },
      { ...check, name: "About", status: "pass", note: null, severity: null },
    ]);
    expect(report).toContain("QA failed: layout broken");
    expect(report).toContain("**Home** (visual · / · mobile · light · critical): button overflows");
    expect(report).toContain("diff `/a/diff.png`");
    expect(report).not.toContain("About");
  });
});

describe("browserActionLabel", () => {
  const origin = "http://localhost:5100";
  it("describes browser actions relative to the preview origin", () => {
    expect(
      browserActionLabel(
        "mcp__playwright__browser_navigate",
        { url: `${origin}/about.html` },
        origin,
      ),
    ).toBe("Opened /about.html");
    expect(browserActionLabel("mcp__playwright__browser_navigate", { url: origin }, origin)).toBe(
      "Opened /",
    );
    expect(
      browserActionLabel(
        "mcp__playwright__browser_click",
        { element: "Submit button", ref: "e5" },
        origin,
      ),
    ).toBe("Clicked Submit button");
    expect(browserActionLabel("mcp__playwright__browser_click", { target: "e5" }, origin)).toBe(
      "Clicked e5",
    );
    expect(browserActionLabel("mcp__playwright__browser_press_key", { key: "Enter" }, origin)).toBe(
      "Pressed Enter",
    );
  });

  it("is null for screenshots, snapshots and non-browser tools", () => {
    expect(browserActionLabel("mcp__playwright__browser_take_screenshot", {}, origin)).toBeNull();
    expect(browserActionLabel("mcp__playwright__browser_snapshot", {}, origin)).toBeNull();
    expect(browserActionLabel("Read", { file_path: "/x" }, origin)).toBeNull();
  });
});

describe("judgedStatus", () => {
  it("turns a judged-fine changed screen into intended", () => {
    expect(judgedStatus("changed", "pass")).toBe("intended");
    expect(judgedStatus("pass", "pass")).toBe("pass");
    expect(judgedStatus("changed", "fail")).toBe("fail");
    expect(judgedStatus("changed", "intended")).toBe("intended");
  });
});

const screen = (path: string, name = path) => ({ name, path, reason: `because ${path}` });
const section = (name: string, size: number) =>
  `diff --git a/${name} b/${name}\n${"+".repeat(size)}\n`;

describe("planner", () => {
  it("accepts only concrete absolute paths", () => {
    expect(visitablePath(" /1-acme/projects/482 ")).toBe("/1-acme/projects/482");
    expect(visitablePath("/:workspace/projects")).toBeNull();
    expect(visitablePath("/users/[id]")).toBeNull();
    expect(visitablePath("/files/*")).toBeNull();
    expect(visitablePath("http://localhost:3000/x")).toBeNull();
    expect(visitablePath("//evil.com")).toBeNull();
  });

  it("merges pinned routes first, dedupes, drops unvisitable paths and caps", () => {
    const station = { ...QA_STATION_TEMPLATE, alwaysCheck: [{ name: "Home", path: "/" }] };
    const merged = mergePlan(station, {
      screens: [
        screen("/"),
        screen("/:id"),
        ...Array.from({ length: 10 }, (_, i) => screen(`/p${i}`)),
      ],
      scenarios: [
        { name: "Modal", path: "/:id", steps: "Click Edit", reason: "EditModal changed" },
        { name: "", path: "/", steps: "x", reason: "" },
      ],
    });
    expect(merged?.screens[0]).toEqual({ name: "Home", path: "/", reason: PINNED_REASON });
    expect(merged?.screens).toHaveLength(1 + MAX_PLANNED_SCREENS);
    expect(merged?.screens.map((s) => s.path)).not.toContain("/:id");
    // A scenario with an unvisitable start path starts at "/".
    expect(merged?.scenarios).toEqual([
      { name: "Modal", path: "/", steps: "Click Edit", reason: "EditModal changed" },
    ]);
  });

  it("returns null when the plan has no usable screen, so QA falls back", () => {
    expect(mergePlan(QA_STATION_TEMPLATE, { screens: [screen("/:x")], scenarios: [] })).toBeNull();
    const pinnedOnly = { ...QA_STATION_TEMPLATE, alwaysCheck: [{ name: "Home", path: "/" }] };
    expect(mergePlan(pinnedOnly, { screens: [screen("/")], scenarios: [] })).toBeNull();
  });

  it("trims a long diff at file boundaries", () => {
    const diff = section("a.ts", 50) + section("b.ts", 500) + section("c.ts", 50);
    const trimmed = trimDiff(diff, 200);
    expect(trimmed).toContain("a/a.ts");
    expect(trimmed).toContain("a/c.ts");
    expect(trimmed).not.toContain("a/b.ts");
    expect(trimmed).toContain("1 file diff omitted");
    expect(trimDiff("small", 200)).toBe("small");
  });

  it("puts the route map's example URLs in the planner prompt", () => {
    const prompt = buildPlannerPrompt({
      title: "Tweak task row",
      description: "",
      diffStat: " src/task-row.tsx | 2 +-",
      diff: "diff --git a/src/task-row.tsx b/src/task-row.tsx",
      routeMap: {
        routerFiles: ["src/App.tsx"],
        routes: [
          {
            path: "/:ws/tasks",
            example: "/1-acme/tasks",
            title: "Tasks",
            description: "All tasks",
            components: ["src/routes/tasks.tsx"],
          },
        ],
        sourceHash: "x",
        generatedAt: "2026-10-03T10:00:00.000Z",
        editedByHuman: false,
      },
      pinned: [],
      baseUrlPath: "/",
      previousReport: null,
    });
    expect(prompt).toContain("- Tasks: `/:ws/tasks` → example `/1-acme/tasks` — All tasks");
    expect(prompt).toContain("components: src/routes/tasks.tsx");
    expect(prompt).not.toContain("Already checked");
  });
});
