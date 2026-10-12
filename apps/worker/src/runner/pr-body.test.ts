import { describe, expect, it } from "vitest";
import { renderPrBody, SIGNATURE, stripCommitNotes, stripFiller } from "./pr-body";

const base = {
  description:
    'Hand-rolled number fields moved.\nFiles\ncomponents/a.tsx\nDone when\nno type="number" left',
  summary: "Migrated **6 files** to `NumberInput`.",
  diffStat: " components/a.tsx | 12 +++---\n 1 file changed, 8 insertions(+), 4 deletions(-)\n",
  verdict: {
    verdict: "pass" as const,
    summary: "All six files migrated.",
    findings: [
      { severity: "minor" as const, file: "components/a.tsx", message: "Unused import" },
      { severity: "important" as const, file: null, message: "No e2e run" },
    ],
  },
  stations: [
    {
      name: "Research",
      kind: "agent" as const,
      status: "passed",
      attempts: 1,
      model: "claude-haiku-4-5",
      costUsd: 0.28,
      shifts: null,
    },
    {
      name: "Approve plan",
      kind: "gate" as const,
      status: "passed",
      attempts: 1,
      model: null,
      costUsd: 0,
      shifts: null,
    },
    {
      name: "Build",
      kind: "shift" as const,
      status: "passed",
      attempts: 2,
      model: "claude-sonnet-5-5",
      costUsd: 2.07,
      shifts: 4,
    },
  ],
  estimated: true,
};

describe("renderPrBody", () => {
  it("leads with the outcome and ends with the signature", () => {
    const body = renderPrBody(base);
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## Changes"));
    expect(body.indexOf("## Changes")).toBeLessThan(body.indexOf("## Validation"));
    expect(body).toContain("Migrated **6 files**");
    expect(body.trimEnd().endsWith(`<sub>${SIGNATURE}</sub>`)).toBe(true);
    expect(body).not.toContain("Built by");
  });

  it("keeps the raw work order readable inside a collapsed text block", () => {
    const body = renderPrBody(base);
    expect(body).toContain("<details><summary>Work order</summary>\n\n```text\nHand-rolled");
  });

  it("groups findings by severity, most severe first", () => {
    const body = renderPrBody(base);
    expect(body).toContain("**✅ Pass** — All six files migrated.");
    expect(body.indexOf("important (1)")).toBeLessThan(body.indexOf("minor (1)"));
    expect(body).toContain("- `components/a.tsx` — Unused import");
  });

  it("renders the pipeline with shifts, attempts and an estimated total", () => {
    const body = renderPrBody(base);
    expect(body).toContain("| Build | passed | claude-sonnet-5-5 | 4 shifts | $2.07 |");
    expect(body).toContain("| Approve plan | passed | human | 1 |  |");
    expect(body).toContain("**$2.35** est.");
  });

  it("omits empty sections and uses a longer fence when the text has backticks", () => {
    const body = renderPrBody({
      ...base,
      summary: null,
      verdict: null,
      diffStat: "",
      description: "use ```code```",
    });
    expect(body).not.toContain("## Summary");
    expect(body).not.toContain("## Validation");
    expect(body).toContain("````text\nuse ```code```\n````");
  });
});

describe("renderPrBody QA section", () => {
  it("renders counts and failing checks first", () => {
    const body = renderPrBody({
      description: "",
      summary: null,
      diffStat: "",
      verdict: null,
      stations: [],
      estimated: false,
      qa: {
        status: "passed",
        attempts: 2,
        summary: "Heading changed as asked.",
        checks: [
          {
            name: "Home",
            kind: "visual",
            status: "intended",
            path: "/",
            viewport: "desktop",
            theme: "light",
            accepted: false,
          },
          {
            name: "About",
            kind: "visual",
            status: "pass",
            path: "/about",
            viewport: "desktop",
            theme: "light",
            accepted: false,
          },
          {
            name: "Mobile nav",
            kind: "visual",
            status: "intended",
            path: "/",
            viewport: "mobile",
            theme: "light",
            accepted: true,
          },
        ],
      },
    });
    expect(body).toContain("## QA");
    expect(body).toContain("**✅ Pass** after 2 attempts — 2 intended · 1 pass");
    expect(body.indexOf("Home")).toBeLessThan(body.indexOf("About"));
    expect(body).toContain("✅ intended (accepted) | Mobile nav");
  });
});

describe("stripFiller", () => {
  it("drops the agent's opening chatter", () => {
    expect(stripFiller("Perfect. Done: added `title` to the header.")).toBe(
      "Added `title` to the header.",
    );
    expect(stripFiller("Great! All set — the footer has a contact line.")).toBe(
      "The footer has a contact line.",
    );
  });

  it("keeps a summary that starts with the change", () => {
    expect(stripFiller("Added a footer line.")).toBe("Added a footer line.");
    expect(stripFiller("Done.")).toBe("Done.");
  });
});

describe("stripCommitNotes", () => {
  it("drops what the builder said about the uncommitted worktree", () => {
    expect(
      stripCommitNotes(
        "Added the tests.\n\nChecks pass.\n\nNothing is committed; the change is in the working tree.",
      ),
    ).toBe("Added the tests.\n\nChecks pass.");
    expect(
      stripCommitNotes(
        "Done. Nothing is committed.\n\n**Changed files** (nothing committed):\n- a.ts",
      ),
    ).toBe("Done.\n\n**Changed files**:\n- a.ts");
  });

  it("keeps a summary that says nothing about commits", () => {
    expect(stripCommitNotes("Committed nothing new to the API; the UI changed.")).toBe(
      "Committed nothing new to the API; the UI changed.",
    );
  });
});
