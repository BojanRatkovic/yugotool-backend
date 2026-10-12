import { query } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "@temporalio/activity";
import {
  type Effort,
  ROUTE_DISCOVERY_JSON_SCHEMA,
  type RouteDiscovery,
  routeDiscoveryOutputSchema,
  type RouteMap,
  type RunEventType,
  type ServerEvent,
} from "@yugotool/contracts";
import { type Database, projects } from "@yugotool/db";
import { eq } from "drizzle-orm";
import { localRunner } from "../runner/local-runner";
import { buildDiscoveryPrompt, normalizeDiscovery, routeSourceHash } from "../runner/route-map";
import { accountNote, type ClaudeAuth, claudeAuthFor, withClaudeAuth } from "../claude-env";
import { sandboxFor } from "../runner/sandbox";

const HEARTBEAT_MS = 10_000;
/** Discovery is a short read-only session: a cheap model is enough. */
const ROUTE_DISCOVERY_MODEL = "claude-haiku-5-5";
const DISCOVERY_MAX_TURNS = 40;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

export interface SessionEvents {
  /** Session lifecycle and tool calls, e.g. into a station's activity feed. */
  log(type: RunEventType, message: string): Promise<void>;
  /** Called on init with the session id and model. */
  onInit?(sessionId: string, model: string): Promise<void>;
}

export interface StructuredResult {
  /** The schema-validated output; null when the session ended without one. */
  output: unknown;
  costUsd: number;
  /** Why there is no output (result subtype or the final text); null on success. */
  error: string | null;
}

/**
 * A sandboxed read-only Claude session in `cwd` that must answer with JSON
 * matching `schema`. Used by route discovery and the QA planner.
 */
export async function runStructuredSession(args: {
  label: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  schema: Record<string, unknown>;
  model: string;
  effort: Effort | null;
  maxTurns: number;
  /** The project's Claude account (spec 0016). */
  auth: ClaudeAuth;
  signal?: AbortSignal;
  events?: SessionEvents;
}): Promise<StructuredResult> {
  const ctx = Context.current();
  const abortController = new AbortController();
  args.signal?.addEventListener("abort", () => abortController.abort());
  const sandboxed = withClaudeAuth(await sandboxFor(args.cwd), args.auth);
  const session = query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      model: args.model,
      ...(args.effort ? { effort: args.effort } : {}),
      outputFormat: { type: "json_schema" as const, schema: args.schema },
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      permissionMode: "dontAsk",
      ...sandboxed,
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: args.systemPrompt },
      abortController,
      maxTurns: args.maxTurns,
    },
  });
  let output: unknown = null;
  let costUsd = 0;
  let error: string | null = "session ended without a result";
  for await (const message of session) {
    ctx.heartbeat();
    if (message.type === "system" && message.subtype === "init") {
      await args.events?.onInit?.(message.session_id, message.model);
      await args.events?.log(
        "system",
        `${args.label} ${message.session_id} · ${message.model}${args.effort ? ` · effort ${args.effort}` : ""}${accountNote(args.auth)}`,
      );
    } else if (message.type === "assistant" && args.events) {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          await args.events.log("text", block.text);
        } else if (block.type === "tool_use") {
          await args.events.log("tool_use", `${block.name} ${JSON.stringify(block.input)}`);
        }
      }
    } else if (message.type === "result") {
      costUsd = message.total_cost_usd;
      if (message.subtype === "success" && message.structured_output !== undefined) {
        output = message.structured_output;
        error = null;
      } else {
        error =
          message.subtype === "success"
            ? `no structured output: ${message.result.slice(0, 300)}`
            : `${args.label} ended: ${message.subtype}`;
      }
      await args.events?.log(
        "result",
        // Starts with the subtype like every other result line (clients key the icon off it).
        `${message.subtype} · ${message.num_turns} turns · $${message.total_cost_usd.toFixed(4)} · ${args.label}`,
      );
    }
  }
  return { output, costUsd, error };
}

export interface RouteDeps {
  notify(event: ServerEvent): Promise<void>;
}

/**
 * Reads the router and mock data in `cwd` and stores the route map on the
 * project, keyed by the hash of its source files at `hashRef`. Records the
 * outcome in `projects.route_discovery` either way.
 */
export async function discoverRouteMap(
  db: Database,
  deps: RouteDeps,
  args: {
    projectId: string;
    cwd: string;
    /** Commit the source hash is computed at (the base the map describes). */
    hashRef: string;
    signal?: AbortSignal;
    events?: SessionEvents;
  },
): Promise<{ map: RouteMap | null; costUsd: number; error: string | null }> {
  const started = Date.now();
  const [project] = await db.select().from(projects).where(eq(projects.id, args.projectId));
  if (!project) throw new Error(`project ${args.projectId} not found`);
  const finish = async (
    map: RouteMap | null,
    costUsd: number,
    error: string | null,
  ): Promise<{ map: RouteMap | null; costUsd: number; error: string | null }> => {
    const discovery: RouteDiscovery = {
      ok: error === null,
      error,
      costUsd,
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
    };
    await db
      .update(projects)
      .set({ routeDiscovery: discovery, ...(map ? { routeMap: map } : {}) })
      .where(eq(projects.id, args.projectId));
    await deps.notify({ type: "invalidate", collection: "projects" });
    return { map, costUsd, error };
  };
  try {
    const result = await runStructuredSession({
      label: "Route discovery",
      auth: await claudeAuthFor({ projectId: args.projectId }),
      cwd: args.cwd,
      prompt: buildDiscoveryPrompt({
        baseUrlPath: project.preview?.baseUrlPath ?? "/",
        previewStart: project.preview?.start ?? null,
      }),
      systemPrompt:
        "You map a web app's screens for a QA tool. Read only what you need, never edit files, and answer with the JSON schema.",
      schema: ROUTE_DISCOVERY_JSON_SCHEMA,
      model: ROUTE_DISCOVERY_MODEL,
      effort: "low",
      maxTurns: DISCOVERY_MAX_TURNS,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.events ? { events: args.events } : {}),
    });
    const parsed = routeDiscoveryOutputSchema.safeParse(result.output);
    if (!parsed.success)
      return await finish(null, result.costUsd, result.error ?? "invalid output");
    const { routerFiles, routes } = normalizeDiscovery(parsed.data);
    if (routes.length === 0)
      return await finish(null, result.costUsd, "Discovery found no visitable routes");
    const map: RouteMap = {
      routerFiles,
      routes,
      sourceHash: routerFiles.length
        ? await routeSourceHash(args.cwd, args.hashRef, routerFiles)
        : null,
      generatedAt: new Date().toISOString(),
      editedByHuman: false,
    };
    return await finish(map, result.costUsd, null);
  } catch (error) {
    return finish(null, 0, error instanceof Error ? error.message : String(error));
  }
}

export function createRouteActivities(db: Database, deps: RouteDeps) {
  return {
    /** Project settings → "Discover routes": a session on the base branch in a throwaway worktree. */
    async discoverRoutes(input: {
      projectId: string;
    }): Promise<{ ok: boolean; error: string | null }> {
      const ctx = Context.current();
      const heartbeat = setInterval(() => ctx.heartbeat(), HEARTBEAT_MS);
      const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
      if (!project) throw new Error(`project ${input.projectId} not found`);
      let worktree: string | null = null;
      try {
        const ref = await localRunner.baseRef(project.repoPath, project.baseBranch);
        worktree = await localRunner.addDetachedWorktree(
          project.repoPath,
          ref,
          `routes-${input.projectId}`,
        );
        const result = await discoverRouteMap(db, deps, {
          projectId: input.projectId,
          cwd: worktree,
          hashRef: "HEAD",
          signal: ctx.cancellationSignal,
        });
        return { ok: result.error === null, error: result.error };
      } finally {
        clearInterval(heartbeat);
        if (worktree) await localRunner.removeWorktree(project.repoPath, worktree);
      }
    },
  };
}
