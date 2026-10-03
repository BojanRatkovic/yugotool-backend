import { QA_STATION_TEMPLATE, DEFAULT_STATIONS, withQaStation } from "@zastava/contracts";
import { describe, expect, it } from "vitest";
import { detectPreview, type RepoFacts } from "../src/modules/projects/preview-detect";

const facts = (over: Partial<RepoFacts>): RepoFacts => ({
  files: [],
  packageJson: null,
  nvmrc: null,
  nodeVersionFile: null,
  ...over,
});

describe("detectPreview", () => {
  it("vite + pnpm lockfile → frozen install and port flags without --", () => {
    const d = detectPreview(
      facts({
        files: ["package.json", "pnpm-lock.yaml"],
        packageJson: { scripts: { dev: "vite" }, devDependencies: { vite: "^7" } },
      }),
    );
    expect(d.framework).toBe("Vite");
    expect(d.packageManager).toBe("pnpm");
    expect(d.preview?.install).toBe("pnpm install --frozen-lockfile");
    expect(d.preview?.start).toBe("pnpm dev --port $PORT --strictPort");
    expect(d.notes).toEqual([]);
  });

  it("next + npm lockfile → npm ci, `--` before the flag, longer timeout", () => {
    const d = detectPreview(
      facts({
        files: ["package-lock.json"],
        packageJson: { scripts: { dev: "next dev" }, dependencies: { next: "15", react: "19" } },
      }),
    );
    expect(d.framework).toBe("Next.js");
    expect(d.preview?.install).toBe("npm ci");
    expect(d.preview?.start).toBe("npm run dev -- -p $PORT");
    expect(d.preview?.readyTimeoutSec).toBe(300);
  });

  it("prefers the most specific framework (SvelteKit over Vite)", () => {
    const d = detectPreview(
      facts({
        files: ["yarn.lock"],
        packageJson: {
          scripts: { dev: "vite dev" },
          devDependencies: { vite: "7", "@sveltejs/kit": "2" },
        },
      }),
    );
    expect(d.framework).toBe("SvelteKit");
    expect(d.preview?.start).toBe("yarn dev --port $PORT --strictPort");
    expect(d.preview?.install).toBe("yarn install --frozen-lockfile");
  });

  it("a compound dev script gets no flags and a note to check the port", () => {
    const d = detectPreview(
      facts({
        files: ["package-lock.json"],
        packageJson: {
          scripts: { dev: "concurrently 'node mock.js' 'vite'" },
          devDependencies: { vite: "7" },
        },
      }),
    );
    expect(d.preview?.start).toBe("npm run dev");
    expect(d.notes.join(" ")).toMatch(/check it listens on \$PORT/);
  });

  it("falls back to the start script and the packageManager field without a lockfile", () => {
    const d = detectPreview(
      facts({
        packageJson: {
          packageManager: "pnpm@10.4.0",
          scripts: { start: "react-scripts start" },
          dependencies: { "react-scripts": "5" },
        },
      }),
    );
    expect(d.packageManager).toBe("pnpm");
    expect(d.preview?.install).toBe("pnpm install");
    expect(d.preview?.start).toBe("pnpm start");
    expect(d.notes.join(" ")).toMatch(/No lockfile/);
  });

  it("reports the pinned Node version", () => {
    const d = detectPreview(
      facts({
        files: ["bun.lock"],
        nvmrc: "v22.12.0\n",
        packageJson: { scripts: { dev: "vite" }, devDependencies: { vite: "7" } },
      }),
    );
    expect(d.nodeVersion).toBe("22.12.0");
    expect(d.preview?.start).toBe("bun run dev --port $PORT --strictPort");
    expect(d.notes[0]).toMatch(/Node 22\.12\.0 is pinned in \.nvmrc/);
  });

  it("serves a static site without package.json", () => {
    const d = detectPreview(facts({ files: ["index.html", "styles.css"] }));
    expect(d.framework).toBe("Static site");
    expect(d.preview?.install).toBeNull();
    expect(d.preview?.start).toContain("$PORT");
  });

  it("proposes nothing for a monorepo without a root dev script", () => {
    const d = detectPreview(
      facts({ files: ["pnpm-lock.yaml"], packageJson: { workspaces: ["apps/*"], scripts: {} } }),
    );
    expect(d.preview).toBeNull();
    expect(d.notes.join(" ")).toMatch(/monorepo/);
  });

  it("skips install when package.json has no dependencies", () => {
    const d = detectPreview(facts({ packageJson: { scripts: { start: "node server.js" } } }));
    expect(d.preview?.install).toBeNull();
    expect(d.preview?.start).toBe("npm run start");
    expect(d.notes.join(" ")).not.toMatch(/lockfile/);
  });

  it("proposes nothing for a repo with no app at the root", () => {
    const d = detectPreview(facts({ files: ["README.md"] }));
    expect(d.preview).toBeNull();
    expect(d.notes).toHaveLength(1);
  });
});

describe("withQaStation", () => {
  it("inserts QA right after the last station that edits code", () => {
    const keys = withQaStation(DEFAULT_STATIONS).map((s) => s.key);
    expect(keys).toEqual(["research", "plan_gate", "build", "qa", "validate", "review_gate"]);
  });

  it("leaves a line that already has QA alone", () => {
    const line = withQaStation(DEFAULT_STATIONS);
    expect(withQaStation(line)).toBe(line);
  });

  it("picks a free key when 'qa' is taken", () => {
    const line = DEFAULT_STATIONS.map((s) => (s.key === "research" ? { ...s, key: "qa" } : s));
    const added = withQaStation(line).find((s) => s.kind === "qa");
    expect(added).toEqual({ ...QA_STATION_TEMPLATE, key: "qa_2" });
  });
});
