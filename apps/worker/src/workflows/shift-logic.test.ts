import {
  type AgentStation,
  DEFAULT_STATIONS,
  HANDOFF_JSON_SCHEMA,
  type Handoff,
  handoffSchema,
  type ShiftStation,
} from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import {
  asShiftStation,
  BUILD_SHIFT_GOAL,
  buildHandoffPrompt,
  buildShiftPrompt,
  canResumeShift,
  contextPct,
  effectiveHandoffTokens,
  handoffFromFeedback,
  handoffThreshold,
  isStuck,
  lastProgressEntries,
  relativeToWorktree,
  renderGoal,
  renderProgressEntry,
} from "./shift-logic";

const station: ShiftStation = {
  key: "build",
  kind: "shift",
  name: "Build",
  role: "builder",
  model: "claude-haiku-4-5-20251001",
  allowedTools: ["Read"],
  prompt: "",
  goal: "Implement the calculator",
  doneCommand: "npm test",
  handoffAtPct: 50,
  maxShifts: 8,
  reviewHandoff: false,
};

const handoff: Handoff = {
  summary: "Half of the operations are in.",
  done: ["add", "sub"],
  inProgress: "mul in src/calc.js has no tests yet",
  nextSteps: ["test mul", "implement div"],
  gotchas: ["div by zero must throw"],
  filesToRead: ["src/calc.js"],
};

describe("handoff schema", () => {
  it("parses a full handoff and rejects a partial one", () => {
    expect(handoffSchema.parse(handoff)).toEqual(handoff);
    expect(handoffSchema.safeParse({ summary: "x" }).success).toBe(false);
  });

  it("exports a draft-7 JSON schema without a $schema URI", () => {
    expect(HANDOFF_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(HANDOFF_JSON_SCHEMA).toMatchObject({ type: "object" });
  });
});

describe("threshold math", () => {
  it("hands off at the configured share of the window", () => {
    expect(handoffThreshold(50, 200_000)).toBe(100_000);
    expect(handoffThreshold(30, 200_000)).toBe(60_000);
    expect(contextPct(51_000, 100_000)).toBe(51);
    expect(contextPct(10, 0)).toBe(0);
  });

  it("moves the line above the session's starting context", () => {
    expect(effectiveHandoffTokens(50, 200_000, 64_000)).toEqual({ tokens: 100_000, raised: false });
    expect(effectiveHandoffTokens(30, 200_000, 64_000)).toEqual({ tokens: 79_000, raised: true });
  });
});

describe("stuck detection", () => {
  it("needs two shifts in a row without commits", () => {
    expect(isStuck([{ commits: 0, tasksDone: 0 }])).toBe(false);
    expect(
      isStuck([
        { commits: 0, tasksDone: 0 },
        { commits: 0, tasksDone: 0 },
      ]),
    ).toBe(true);
    expect(
      isStuck([
        { commits: 1, tasksDone: 2 },
        { commits: 0, tasksDone: 2 },
      ]),
    ).toBe(false);
  });

  it("does not count ticked-off tasks without code changes as progress", () => {
    expect(
      isStuck([
        { commits: 1, tasksDone: 3 },
        { commits: 0, tasksDone: 4 },
        { commits: 0, tasksDone: 5 },
      ]),
    ).toBe(true);
  });
});

describe("prompt builder", () => {
  it("asks the first shift to create tasks.json", () => {
    const prompt = buildShiftPrompt({
      number: 1,
      station,
      goal: "# Goal",
      previousHandoff: null,
      recentProgress: "",
      gitLog: "",
    });
    expect(prompt).toContain("Shift 1 of at most 8");
    expect(prompt).toContain("Create `.yugotool/tasks.json`");
    expect(prompt).toContain("Start by running `npm test`");
  });

  it("puts the previous handoff, progress and git log into later shifts", () => {
    const prompt = buildShiftPrompt({
      number: 2,
      station,
      goal: "# Goal",
      previousHandoff: handoff,
      recentProgress: "## Shift 1 · threshold · 51% context",
      gitLog: "a1b2c3d yugotool: shift 1",
    });
    expect(prompt).toContain("Handoff from the previous shift");
    expect(prompt).toContain("1. test mul\n2. implement div");
    expect(prompt).toContain("div by zero must throw");
    expect(prompt).toContain("## Shift 1 · threshold");
    expect(prompt).toContain("a1b2c3d yugotool: shift 1");
    expect(prompt).not.toContain("Create `.yugotool/tasks.json`");
  });

  it("states why a handoff is asked for", () => {
    expect(buildHandoffPrompt(51, "threshold")).toContain("Context is at 51%");
    expect(buildHandoffPrompt(20, "manual")).toContain("A human asked");
  });

  it("turns loop-back feedback into next steps", () => {
    expect(handoffFromFeedback("Validate", "fix div").nextSteps).toEqual(["fix div"]);
  });
});

describe("progress.md", () => {
  it("keeps only the last entries for the prompt", () => {
    const progress = [1, 2, 3, 4]
      .map((n) =>
        renderProgressEntry({
          number: n,
          endReason: "threshold",
          contextPct: 50,
          handoff,
          output: "",
        }),
      )
      .join("\n");
    const recent = lastProgressEntries(progress);
    expect(recent).not.toContain("## Shift 1 ");
    expect(recent).toContain("## Shift 2 ");
    expect(recent).toContain("## Shift 4 ");
  });
});

describe("relativeToWorktree", () => {
  it("strips the worktree prefix and leaves relative paths alone", () => {
    expect(relativeToWorktree("/wt/run/src/a.js", "/wt/run")).toBe("src/a.js");
    expect(relativeToWorktree("src/a.js", "/wt/run")).toBe("src/a.js");
  });
});

describe("builders in shifts (spec 0012)", () => {
  const found = DEFAULT_STATIONS.find((s) => s.kind === "agent" && s.canEdit);
  if (found?.kind !== "agent") throw new Error("the default line has no builder");
  const build: AgentStation = found;

  it("turns an editing station into a shift station with defaults or its own settings", () => {
    const plan = asShiftStation(build);
    expect(plan).toMatchObject({
      key: build.key,
      kind: "shift",
      model: build.model,
      allowedTools: build.allowedTools,
      prompt: build.prompt,
      goal: BUILD_SHIFT_GOAL,
      doneCommand: null,
      handoffAtPct: 50,
      maxShifts: 8,
      reviewHandoff: false,
    });
    expect(plan).not.toHaveProperty("maxBudgetUsd");
    expect(
      asShiftStation({
        ...build,
        handoffAtPct: 35,
        maxShifts: 3,
        reviewHandoff: true,
        maxBudgetUsd: 2,
      }),
    ).toMatchObject({ handoffAtPct: 35, maxShifts: 3, reviewHandoff: true, maxBudgetUsd: 2 });
  });

  it("resumes the last session only when it finished below the handoff line with headroom", () => {
    const done = { endReason: "done", sessionId: "s1", contextPct: 38 };
    expect(canResumeShift(done, 50)).toBe(true);
    expect(canResumeShift({ ...done, contextPct: 41 }, 50)).toBe(false);
    expect(canResumeShift({ ...done, endReason: "threshold" }, 50)).toBe(false);
    expect(canResumeShift({ ...done, sessionId: null }, 50)).toBe(false);
    expect(canResumeShift(undefined, 50)).toBe(false);
  });

  it("uses the station brief as the goal instead of title and description", () => {
    const goal = renderGoal({
      title: "T",
      description: "D",
      station: asShiftStation(build),
      brief: "# Work order: T\n\n## Previous stations\n### Research\n1. plan",
    });
    expect(goal).toContain("### Research\n1. plan");
    expect(goal).not.toContain("## Work order: T\nD");
    expect(goal).toContain(BUILD_SHIFT_GOAL);
    expect(goal).toContain("No command: you decide when the goal is met");
  });
});
