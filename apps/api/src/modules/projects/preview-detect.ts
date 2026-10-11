import type { Preview, PreviewDetection } from "@yugotool/contracts";

type PackageManager = NonNullable<PreviewDetection["packageManager"]>;

/** What detection looks at: the repo root on the base branch. */
export interface RepoFacts {
  /** File names at the repo root. */
  files: string[];
  /** Parsed root package.json; null when missing or unreadable. */
  packageJson: PackageJson | null;
  /** Contents of .nvmrc / .node-version, if present. */
  nvmrc: string | null;
  nodeVersionFile: string | null;
}

export interface PackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
}

interface Framework {
  name: string;
  /** Package that identifies it. */
  dep: string;
  /** Binary that starts it inside a script, e.g. "vite" in `"dev": "vite"`. */
  bin: RegExp;
  /** Flags that make it listen on `$PORT`; null = it reads the PORT env var. */
  portFlags: string | null;
}

/** Most specific first: Next/Nuxt/Astro/SvelteKit ship Vite or webpack as a dependency. */
const FRAMEWORKS: Framework[] = [
  { name: "Next.js", dep: "next", bin: /^next\s+dev\b/, portFlags: "-p $PORT" },
  { name: "Nuxt", dep: "nuxt", bin: /^nuxi?\s+dev\b/, portFlags: "--port $PORT" },
  { name: "Astro", dep: "astro", bin: /^astro\s+dev\b/, portFlags: "--port $PORT" },
  { name: "Remix", dep: "@remix-run/dev", bin: /^remix\s+vite:dev\b/, portFlags: "--port $PORT" },
  {
    name: "SvelteKit",
    dep: "@sveltejs/kit",
    bin: /^vite(\s+dev)?\b/,
    portFlags: "--port $PORT --strictPort",
  },
  { name: "Angular", dep: "@angular/cli", bin: /^ng\s+serve\b/, portFlags: "--port $PORT" },
  { name: "Ember", dep: "ember-cli", bin: /^ember\s+s(erve)?\b/, portFlags: "--port $PORT" },
  { name: "Gatsby", dep: "gatsby", bin: /^gatsby\s+develop\b/, portFlags: "-p $PORT" },
  {
    name: "Create React App",
    dep: "react-scripts",
    bin: /^react-scripts\s+start\b/,
    portFlags: null,
  },
  {
    name: "Vite",
    dep: "vite",
    bin: /^vite(\s+(dev|serve))?\b/,
    portFlags: "--port $PORT --strictPort",
  },
];

const SCRIPT_PREFERENCE = ["dev", "start", "serve"];

/**
 * Proposes a preview from the repo's root files. Pure: the caller reads the
 * files. The proposal is a starting point — notes say what to check by hand.
 */
export function detectPreview(facts: RepoFacts): PreviewDetection {
  const nodeVersion = clean(facts.nvmrc) ?? clean(facts.nodeVersionFile);
  const notes: string[] = [];
  if (nodeVersion) {
    notes.push(
      `Node ${nodeVersion} is pinned in ${facts.nvmrc ? ".nvmrc" : ".node-version"}; YugoTool runs the preview, checks and agents under it (downloaded once).`,
    );
  }

  const pkg = facts.packageJson;
  if (!pkg) {
    if (facts.files.includes("index.html")) {
      return {
        preview: preview({ install: null, start: "python3 -m http.server $PORT --bind 127.0.0.1" }),
        framework: "Static site",
        packageManager: null,
        nodeVersion,
        notes: [...notes, "No package.json: serving the repo root as static files."],
      };
    }
    return {
      preview: null,
      framework: null,
      packageManager: null,
      nodeVersion,
      notes: [
        ...notes,
        "No package.json or index.html at the repo root. Set the install and start commands by hand.",
      ],
    };
  }

  const pm = packageManager(facts.files, pkg);
  const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
  const hasDeps = Object.keys(deps).length > 0;
  if (hasDeps && !pm.fromLockfile) notes.push(`No lockfile found; installing with ${pm.name}.`);

  const scripts = stringRecord(pkg.scripts);
  const scriptName = SCRIPT_PREFERENCE.find((name) => scripts[name]);
  const framework = FRAMEWORKS.find((f) => f.dep in deps) ?? null;

  if (!scriptName) {
    if (pkg.workspaces) {
      notes.push(
        "This is a monorepo without a root dev script. Point the start command at the app's package.",
      );
    } else {
      notes.push(
        'No "dev", "start" or "serve" script in package.json. Set the start command by hand.',
      );
    }
    return {
      preview: null,
      framework: framework?.name ?? null,
      packageManager: pm.name,
      nodeVersion,
      notes,
    };
  }

  const script = scripts[scriptName] ?? "";
  let start = runScript(pm.name, scriptName);
  if (framework?.portFlags && framework.bin.test(script.trim())) {
    start += `${pm.name === "npm" ? " --" : ""} ${framework.portFlags}`;
  } else if (framework?.portFlags) {
    notes.push(
      `The "${scriptName}" script does more than start ${framework.name}; check it listens on $PORT (the PORT env var is set too).`,
    );
  } else {
    notes.push(
      `Started with "${scriptName}"; the app must listen on the PORT env var (or add a port flag with $PORT).`,
    );
  }
  if (!framework) notes.push("Framework not recognised; check the start command and ready path.");

  return {
    preview: preview({
      install: hasDeps ? installCommand(pm.name, pm.lockfile) : null,
      start,
      // Dev servers that compile on first request (Next, Angular, Ember) need longer.
      readyTimeoutSec:
        framework && ["Next.js", "Angular", "Ember", "Gatsby"].includes(framework.name) ? 300 : 120,
    }),
    framework: framework?.name ?? null,
    packageManager: pm.name,
    nodeVersion,
    notes,
  };
}

function preview(p: Pick<Preview, "install" | "start"> & Partial<Preview>): Preview {
  return {
    readyPath: "/",
    readyTimeoutSec: 120,
    env: {},
    baseUrlPath: "/",
    themeInit: null,
    host: null,
    ...p,
  };
}

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function packageManager(
  files: string[],
  pkg: PackageJson,
): { name: PackageManager; lockfile: string | null; fromLockfile: boolean } {
  const lock = LOCKFILES.find(([file]) => files.includes(file));
  if (lock) return { name: lock[1], lockfile: lock[0], fromLockfile: true };
  const declared =
    typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const name = (["pnpm", "yarn", "bun", "npm"] as const).find((pm) => pm === declared) ?? "npm";
  return { name, lockfile: null, fromLockfile: false };
}

const FROZEN_INSTALL: Record<PackageManager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
};

function installCommand(pm: PackageManager, lockfile: string | null): string {
  return lockfile ? FROZEN_INSTALL[pm] : `${pm} install`;
}

function runScript(pm: PackageManager, script: string): string {
  return pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`;
}

function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

function clean(version: string | null): string | null {
  const v = version?.trim().replace(/^v/, "");
  return v ? v : null;
}
