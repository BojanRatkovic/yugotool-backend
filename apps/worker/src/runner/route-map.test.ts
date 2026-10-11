import type { RouteMap } from "@yugotool/contracts";
import { describe, expect, it } from "vitest";
import { withPorts } from "./preview";
import { needsDiscovery, normalizeDiscovery } from "./route-map";

const map = (patch: Partial<RouteMap> = {}): RouteMap => ({
  routerFiles: ["src/App.tsx"],
  routes: [],
  sourceHash: "abc",
  generatedAt: "2026-10-03T10:00:00.000Z",
  editedByHuman: false,
  ...patch,
});

describe("needsDiscovery", () => {
  it("discovers when missing or when the sources changed", () => {
    expect(needsDiscovery(null, null)).toBe(true);
    expect(needsDiscovery(map(), "abc")).toBe(false);
    expect(needsDiscovery(map(), "def")).toBe(true);
    expect(needsDiscovery(map({ sourceHash: null }), null)).toBe(true);
  });

  it("never replaces a map a human edited", () => {
    expect(needsDiscovery(map({ editedByHuman: true }), "def")).toBe(false);
  });
});

describe("normalizeDiscovery", () => {
  it("keeps visitable routes once and safe relative router files", () => {
    const route = {
      path: "/:ws/projects/:id",
      example: "/1-acme/projects/482",
      title: "Project",
      description: "One project",
      components: ["src/routes/project.tsx"],
    };
    const result = normalizeDiscovery({
      routerFiles: ["./src/App.tsx", "/etc/passwd", "../x", "src/App.tsx", "mock/api.mjs"],
      routes: [
        route,
        { ...route, title: "Duplicate" },
        { ...route, example: "/:ws/projects/:id" },
        { ...route, example: "relative" },
        { ...route, path: "", example: "/1-acme/home", title: "Home" },
      ],
    });
    expect(result.routerFiles).toEqual(["src/App.tsx", "mock/api.mjs"]);
    expect(result.routes.map((r) => [r.path, r.example])).toEqual([
      ["/:ws/projects/:id", "/1-acme/projects/482"],
      ["/1-acme/home", "/1-acme/home"],
    ]);
  });
});

describe("withPorts", () => {
  it("replaces $PORT2 before $PORT", () => {
    expect(
      withPorts("MOCK_PORT=$PORT2 vite --port $PORT --api http://localhost:$PORT2", {
        port: 5000,
        port2: 6000,
      }),
    ).toBe("MOCK_PORT=6000 vite --port 5000 --api http://localhost:6000");
  });
});
