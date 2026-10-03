import { describe, expect, it } from "vitest";
import { repoSlug } from "../src/modules/pull-requests/github/repo-slug";

describe("repoSlug", () => {
  it.each([
    "git@github.com:acme/app.git",
    "git@github.com:acme/app",
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
    "https://github.com/acme/app/",
    "ssh://git@github.com/acme/app.git",
  ])("parses %s", (url) => {
    expect(repoSlug(url)).toEqual({ owner: "acme", name: "app" });
  });

  it("keeps dots and dashes in names", () => {
    expect(repoSlug("git@github.com:my-org/app.web.git")).toEqual({
      owner: "my-org",
      name: "app.web",
    });
  });

  it("rejects non-GitHub origins", () => {
    expect(repoSlug("git@gitlab.com:acme/app.git")).toBeNull();
    expect(repoSlug("https://github.com/acme")).toBeNull();
  });
});
