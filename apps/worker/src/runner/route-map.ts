import type { RouteDiscoveryOutput, RouteEntry, RouteMap } from "@yugotool/contracts";
import { routeEntrySchema } from "@yugotool/contracts";

/** Routes kept from one discovery; a map is a menu for the planner, not a sitemap. */
const MAX_DISCOVERED_ROUTES = 150;

/** A map needs (re)discovery when there is none, or a machine-made one whose sources changed. */
export function needsDiscovery(map: RouteMap | null, currentHash: string | null): boolean {
  if (!map) return true;
  if (map.editedByHuman) return false;
  return map.sourceHash === null || map.sourceHash !== currentHash;
}

export function buildDiscoveryPrompt(input: { baseUrlPath: string; previewStart: string | null }) {
  return [
    "# Map the screens of this app",
    "QA screenshots screens of this app by URL. Build the map it picks from: every screen a user can open, with a concrete URL that works against the app's local/mock data.",
    input.previewStart
      ? `The app runs locally with: \`${input.previewStart}\` (base URL path ${input.baseUrlPath}).`
      : "",
    "## Steps",
    [
      "1. Find the router: route definitions (react-router `<Route>`/`createBrowserRouter`, TanStack/Next/Remix/SvelteKit file routes, Ember `router.ts`/`router.js`, Vue router, …). Grep, do not read the whole repo.",
      "2. Find the data the local app runs against: mock server, mirage, MSW handlers, fixtures, seeds. Copy IDs and slugs verbatim from that data (open the file and find the record; never guess a slug from the product name), so every `example` URL renders real content, not a 404 or an empty state.",
      "3. For each screen: `path` = the router pattern (e.g. `/:workspace/projects/:id`), `example` = a concrete URL with those IDs filled in (e.g. `/1-acme/projects/482`), `title` = what a user calls it, `description` = one sentence on what is on it, `components` = the repo-relative files that render it (the route component and its main children; up to 10).",
      "4. Nested routes: list each leaf screen once with its full path. Skip redirects, auth callbacks and catch-alls; include the sign-in screen only if there is nothing else.",
      `5. \`routerFiles\` = the repo-relative files you read the routes and mock data from (router files, the mock data file(s)). When they change, the map is rebuilt.`,
      `6. Up to ${MAX_DISCOVERED_ROUTES} routes, the most used screens first. Never edit files.`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Validates the session's output into stored routes; drops entries that cannot be visited. */
export function normalizeDiscovery(output: RouteDiscoveryOutput): {
  routerFiles: string[];
  routes: RouteEntry[];
} {
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  for (const raw of output.routes) {
    const parsed = routeEntrySchema.safeParse({
      ...raw,
      path: raw.path.trim() || raw.example.trim(),
      components: raw.components.slice(0, 30),
    });
    if (!parsed.success) continue;
    const example = parsed.data.example;
    if (/(^|\/)(:|\*)|[[\]{}]|\s/.test(example) || seen.has(example)) continue;
    seen.add(example);
    routes.push(parsed.data);
    if (routes.length >= MAX_DISCOVERED_ROUTES) break;
  }
  const routerFiles = [
    ...new Set(
      output.routerFiles
        .map((f) => f.trim().replace(/^\.\//, ""))
        .filter((f) => f && !f.startsWith("/") && !f.includes("..")),
    ),
  ].slice(0, 50);
  return { routerFiles, routes };
}
