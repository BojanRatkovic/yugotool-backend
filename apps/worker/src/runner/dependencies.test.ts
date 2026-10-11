import { describe, expect, it } from "vitest";
import { installSteps } from "./dependencies";

describe("dependency install steps", () => {
  it("follows the root lockfiles, frozen", () => {
    expect(installSteps(new Set(["Gemfile.lock"]), null).map((s) => s.command)).toEqual([
      "bundle install",
    ]);
    expect(installSteps(new Set(["pnpm-lock.yaml"]), "pnpm@10.19.0+sha512.x")[0]?.command).toBe(
      "pnpm install --frozen-lockfile --prefer-offline",
    );
    expect(installSteps(new Set(["yarn.lock", ".yarnrc.yml"]), null)[0]?.command).toContain(
      "--immutable",
    );
    expect(installSteps(new Set(["package-lock.json"]), null)[0]?.label).toBe("npm ci");
    expect(installSteps(new Set(["Gemfile.lock", "package-lock.json"]), null)).toHaveLength(2);
    expect(installSteps(new Set(), null)).toEqual([]);
  });
});
