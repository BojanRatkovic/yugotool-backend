import type { NotificationJob, Station } from "@yugotool/contracts";

/** What a work-order notification is rendered from; loaded once per job. */
export interface WorkOrderContext {
  id: string;
  projectId: string;
  title: string;
  prUrl: string | null;
  /** Review work orders: the PR under review (spec 0009). */
  pullRequestNumber: number | null;
  stations: Station[];
}

export interface RenderedNotification {
  title: string;
  body: string;
  /** In-app path; external channels prefix it with Settings → app URL. */
  path: string;
  projectId: string | null;
  workOrderId: string | null;
}

export interface RenderDeps {
  /** Null when the work order is gone (deleted since the job was queued). */
  workOrder(id: string): Promise<WorkOrderContext | null>;
  projectExists(id: string): Promise<boolean>;
}

interface Definition<P> {
  /** Null = nothing to say any more (its subject was deleted); the job completes silently. */
  render(payload: P, deps: RenderDeps): Promise<RenderedNotification | null>;
}

/** Kind → payload, so the registry and `renderJob` stay correlated without casts. */
type PayloadByKind = { [J in NotificationJob as J["kind"]]: J["payload"] };
type Registry = { [K in keyof PayloadByKind]: Definition<PayloadByKind[K]> };

/** A review opens its pull request; everything else the work order on the board. */
export function workOrderPath(workOrder: WorkOrderContext): string {
  return workOrder.pullRequestNumber !== null
    ? `/projects/${workOrder.projectId}/pulls/assigned?pr=${workOrder.pullRequestNumber}`
    : `/projects/${workOrder.projectId}?view=board&wo=${workOrder.id}`;
}

/** The common shape: about one work order, linked to it. */
function aboutWorkOrder<P extends { workOrderId: string }>(
  compose: (payload: P, workOrder: WorkOrderContext) => { title: string; body: string },
): Definition<P> {
  return {
    async render(payload, deps) {
      const workOrder = await deps.workOrder(payload.workOrderId);
      if (!workOrder) return null;
      return {
        ...compose(payload, workOrder),
        path: workOrderPath(workOrder),
        projectId: workOrder.projectId,
        workOrderId: workOrder.id,
      };
    },
  };
}

/** The API runs on the user's machine, so its local time is theirs. */
const clock = (isoDate: string) =>
  new Date(isoDate).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Every notification kind and how it reads (whether it also goes outside the
 * app is `NOTIFICATION_EXTERNAL_DEFAULTS` + Settings). A `Record` over the kind enum, so
 * adding a kind to the contract without a definition here fails typecheck.
 */
export const NOTIFICATION_DEFINITIONS: Registry = {
  gate_waiting: aboutWorkOrder((p, wo) => ({
    title: `Needs you: ${wo.title}`,
    body: `${wo.stations.find((s) => s.key === p.stationKey)?.name ?? p.stationKey} is waiting for your decision.`,
  })),
  run_failed: aboutWorkOrder((p, wo) => ({
    title: `Run failed: ${wo.title}`,
    body: p.reason ?? "The run stopped with an error.",
  })),
  run_succeeded: aboutWorkOrder((_p, wo) => ({
    title: `Done: ${wo.title}`,
    body: wo.prUrl ? `Pull request: ${wo.prUrl}` : "Committed on its branch.",
  })),
  review_ready: aboutWorkOrder((p, wo) => ({
    title: `Review ready: ${wo.title}`,
    body:
      p.findings === 0
        ? "No findings."
        : `${plural(p.findings, "finding")}; pick the ones to post.`,
  })),
  ci_failed: aboutWorkOrder((p, wo) => ({
    title: `CI failed: ${wo.title}`,
    body: `${p.summary}. ${p.link ?? ""}`.trim(),
  })),
  ci_passed: aboutWorkOrder((p, wo) => ({
    title: `CI passed: ${wo.title}`,
    body: p.summary,
  })),
  shift_handoff_ready: aboutWorkOrder((p, wo) => ({
    title: `Handoff ready for review: ${wo.title}`,
    body: `Shift ${p.number} handed off. Review it before shift ${p.number + 1} starts.`,
  })),
  shift_stuck: aboutWorkOrder((p, wo) => ({
    title: `Stuck after shift ${p.number}: ${wo.title}`,
    body: "Two shifts in a row changed no code. Check the handoff and the goal before restarting.",
  })),
  knowledge_sync_failed: aboutWorkOrder((p, wo) => ({
    title: `Knowledge skipped: ${p.name}`,
    body: `"${wo.title}" planned without it: ${p.error.split("\n")[0]}`,
  })),
  dispatcher_paused: {
    render: (p) =>
      Promise.resolve({
        title: "Queue paused",
        body: p.resumesAt
          ? `${p.reason}. Queued work resumes at ${clock(p.resumesAt)}.`
          : `${p.reason}. Queued work waits until usage drops.`,
        path: "/",
        projectId: null,
        workOrderId: null,
      }),
  },
  pr_review_requested: {
    async render(p, deps) {
      if (!(await deps.projectExists(p.projectId))) return null;
      return {
        title: `Review requested: #${p.number} ${p.title}`,
        body: `${p.author} asked for your review in ${p.repo}.`,
        path: `/projects/${p.projectId}/pulls/assigned?pr=${p.number}`,
        projectId: p.projectId,
        workOrderId: null,
      };
    },
  },
};

export function renderJob<K extends keyof PayloadByKind>(
  job: { kind: K; payload: PayloadByKind[K] },
  deps: RenderDeps,
): Promise<RenderedNotification | null> {
  return NOTIFICATION_DEFINITIONS[job.kind].render(job.payload, deps);
}

/** Fits the contract's limits (and NOTIFY's 8 kB) before storing. */
export function clamp(rendered: RenderedNotification): RenderedNotification {
  return {
    ...rendered,
    title: cut(rendered.title, 200),
    body: cut(rendered.body, 2_000),
    path: cut(rendered.path, 1_000),
  };
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const MAX_ATTEMPTS = 5;

/** Seconds to wait before attempt `attempts + 1`: 2, 4, 8, 16. */
export function backoffSeconds(attempts: number): number {
  return 2 ** attempts;
}
