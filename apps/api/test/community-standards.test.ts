import { describe, expect, it } from "vitest";
import {
  type CommunityProfile,
  type SecurityPolicy,
  toCommunityStandards,
} from "../src/modules/community/github-community";

const slug = { owner: "acme", name: "app" };

function profile(over: Partial<CommunityProfile> = {}): CommunityProfile {
  return {
    health_percentage: 50,
    description: "A thing",
    updated_at: "2026-10-15T00:00:00Z",
    files: {},
    ...over,
  };
}

const noSecurity: SecurityPolicy = { present: false, url: null };

describe("toCommunityStandards", () => {
  it("lists the 8 standards in GitHub's display order", () => {
    const result = toCommunityStandards(profile(), noSecurity, slug);
    expect(result.items.map((i) => i.key)).toEqual([
      "description",
      "readme",
      "code_of_conduct",
      "contributing",
      "license",
      "security_policy",
      "issue_template",
      "pull_request_template",
    ]);
  });

  it("marks a file present and links to it; missing links to the add flow", () => {
    const result = toCommunityStandards(
      profile({
        files: { readme: { html_url: "https://github.com/acme/app/blob/main/README.md" } },
      }),
      noSecurity,
      slug,
    );
    const readme = result.items.find((i) => i.key === "readme")!;
    const coc = result.items.find((i) => i.key === "code_of_conduct")!;
    expect(readme).toMatchObject({
      present: true,
      url: "https://github.com/acme/app/blob/main/README.md",
    });
    expect(coc).toMatchObject({ present: false, url: "https://github.com/acme/app/community" });
  });

  it("treats a null/blank repo description as missing", () => {
    expect(
      toCommunityStandards(profile({ description: null }), noSecurity, slug).items.find(
        (i) => i.key === "description",
      )?.present,
    ).toBe(false);
    expect(
      toCommunityStandards(profile({ description: "  " }), noSecurity, slug).items.find(
        (i) => i.key === "description",
      )?.present,
    ).toBe(false);
  });

  it("uses the separate security probe for the security policy row", () => {
    const result = toCommunityStandards(
      profile(),
      { present: true, url: "https://x/SECURITY.md" },
      slug,
    );
    expect(result.items.find((i) => i.key === "security_policy")).toMatchObject({
      present: true,
      url: "https://x/SECURITY.md",
    });
  });

  it("rounds and clamps GitHub's health percentage, and carries the slug", () => {
    const result = toCommunityStandards(profile({ health_percentage: 85.6 }), noSecurity, slug);
    expect(result.healthPercentage).toBe(86);
    expect(result.slug).toBe("acme/app");
    expect(
      toCommunityStandards(profile({ health_percentage: 140 }), noSecurity, slug).healthPercentage,
    ).toBe(100);
  });
});
