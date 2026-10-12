import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expandHome } from "@yugotool/local";
import { locationProblem } from "../src/modules/knowledge/knowledge.location";

const dir = mkdtempSync(path.join(os.tmpdir(), "yugotool-location-"));
const repo = path.join(dir, "repo");
mkdirSync(path.join(repo, ".git"), { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("locationProblem", () => {
  it("accepts existing paths and real repos", () => {
    expect(locationProblem("path", dir)).toBeNull();
    expect(locationProblem("git_local", repo)).toBeNull();
  });

  it("explains a missing path or a folder that is not a repo", () => {
    expect(locationProblem("path", path.join(dir, "nope"))).toMatch(/does not exist/);
    expect(locationProblem("git_local", dir)).toMatch(/not a Git repository/);
  });

  it("wants a git URL for remotes", () => {
    expect(locationProblem("git_remote", "https://github.com/acme/work")).toBeNull();
    expect(locationProblem("git_remote", "git@github.com:acme/work.git")).toBeNull();
    expect(locationProblem("git_remote", "acme/work")).toMatch(/git URL/);
  });
});

describe("expandHome", () => {
  it("expands ~", () => {
    expect(expandHome("~/x")).toBe(path.join(os.homedir(), "x"));
  });
});
