import { describe, expect, it } from "vitest";
import { remoteVerdict } from "../src/modules/projects/project-remote";

const gh = { ghInstalled: true, ghLoggedIn: true };

describe("remoteVerdict", () => {
  it("allows PRs for a GitHub origin with gh logged in", () => {
    expect(remoteVerdict({ origin: "git@github.com:acme/app.git", ...gh })).toMatchObject({
      github: true,
      prPossible: true,
      reason: null,
    });
  });

  it("explains each blocker", () => {
    expect(remoteVerdict({ origin: null, ...gh }).reason).toMatch(/no origin/);
    expect(remoteVerdict({ origin: "https://gitlab.com/a/b.git", ...gh }).reason).toMatch(
      /not on GitHub/,
    );
    expect(
      remoteVerdict({ origin: "https://github.com/a/b", ghInstalled: false, ghLoggedIn: false })
        .reason,
    ).toMatch(/isn't installed/);
    expect(
      remoteVerdict({ origin: "https://github.com/a/b", ghInstalled: true, ghLoggedIn: false })
        .reason,
    ).toMatch(/gh auth login/);
  });
});
