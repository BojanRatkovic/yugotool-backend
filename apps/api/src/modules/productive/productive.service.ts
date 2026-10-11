import { Injectable } from "@nestjs/common";
import type {
  ConnectProductive,
  ImportProductiveTasks,
  ProductiveConnection,
  ProductiveStatus,
  ProductiveProject,
  ProductiveProjectQuery,
  ProductiveTaskPage,
  ProductiveTaskQuery,
  WorkOrder,
} from "@yugotool/contracts";
import { iso } from "../../common/mappers";
import { DatabaseService } from "../../core/database/database.service";
import { EventsService } from "../../core/events/events.service";
import { maskApiKey } from "../settings/settings.service";
import { WorkOrdersService } from "../work-orders/work-orders.service";
import { htmlToMarkdown } from "./html-to-markdown";
import {
  type ProductiveAuth,
  ProductiveClient,
  type ProductiveTaskRecord,
} from "./productive.client";
import {
  ProductiveNotConnectedError,
  ProductiveOrganizationUnknownError,
  ProductivePickOrganizationError,
  ProductiveTokenInvalidError,
} from "./productive.errors";
import { type ProductiveConnectionRow, ProductiveRepository } from "./productive.repository";

const TASK_PAGE_SIZE = 50;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
/** Task fetches in flight during an import; Productive allows ~100 per 2s per token. */
const IMPORT_CONCURRENCY = 5;

/**
 * Productive integration (spec 0019): a saved API token, read-only access to
 * projects and tasks, and import of tasks into a project's backlog.
 */
@Injectable()
export class ProductiveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProductiveRepository,
    private readonly client: ProductiveClient,
    private readonly workOrders: WorkOrdersService,
    private readonly events: EventsService,
  ) {}

  async status(): Promise<ProductiveStatus> {
    const row = await this.repository.find(this.database.db);
    return { connection: row ? toConnection(row) : null };
  }

  /**
   * Checks the token with Productive, then saves it with the chosen
   * organization. Without a token, switches the saved connection's organization.
   */
  async connect(input: ConnectProductive): Promise<ProductiveConnection> {
    const saved = await this.repository.find(this.database.db);
    const token = input.token ?? saved?.token;
    if (!token) throw new ProductiveNotConnectedError("Paste a Productive API token to connect.");
    const memberships = await this.client.memberships(token);
    if (memberships.length === 0)
      throw new ProductiveTokenInvalidError(
        "This token doesn't belong to any Productive organization.",
      );
    const organizations = memberships.map((m) => m.organization);
    const organizationId =
      input.organizationId ??
      (memberships.length === 1 ? memberships[0]?.organization.id : undefined);
    if (organizationId === undefined)
      throw new ProductivePickOrganizationError(
        "This token reaches several organizations. Pick one.",
        { organizations },
      );
    const membership = memberships.find((m) => m.organization.id === organizationId);
    if (!membership)
      throw new ProductiveOrganizationUnknownError("This token can't reach that organization.", {
        organizations,
      });
    const row = await this.repository.save(this.database.db, {
      token,
      organizationId,
      organizationName: membership.organization.name,
      personId: membership.person?.id ?? null,
      personName: membership.person?.name ?? null,
      organizations,
    });
    await this.events.publish({ type: "invalidate", collection: "integrations" });
    return toConnection(row);
  }

  /** Forgets the token. Imported work orders stay as they are. */
  async disconnect(): Promise<void> {
    await this.repository.remove(this.database.db);
    await this.events.publish({ type: "invalidate", collection: "integrations" });
  }

  async projects(query: ProductiveProjectQuery): Promise<ProductiveProject[]> {
    const { auth } = await this.auth();
    return this.client.projects(auth, query.query);
  }

  /** Open tasks, marked with the work order they became in this project, if any. */
  async tasks(query: ProductiveTaskQuery): Promise<ProductiveTaskPage> {
    const { auth, row } = await this.auth();
    const page = await this.client.tasks(auth, {
      projectId: query.productiveProjectId,
      query: query.query,
      assigneeId: query.mine ? (row.personId ?? undefined) : undefined,
      page: query.page,
      pageSize: TASK_PAGE_SIZE,
    });
    const imported = await this.workOrders.importedSources(
      query.projectId,
      "productive",
      page.items.map((task) => task.id),
    );
    return {
      items: page.items.map((task) => ({
        id: task.id,
        number: task.number,
        title: task.title,
        url: taskUrl(row, task.id),
        projectName: task.projectName,
        status: task.status,
        assigneeName: task.assigneeName,
        dueDate: task.dueDate,
        updatedAt: task.updatedAt,
        workOrderId: imported.get(task.id) ?? null,
      })),
      nextPage: page.nextPage,
    };
  }

  /**
   * Each task becomes a backlog work order: its title, and its description as
   * Markdown. Tasks the project already has are not fetched again.
   */
  async import(input: ImportProductiveTasks): Promise<WorkOrder[]> {
    const { auth, row } = await this.auth();
    const taskIds = [...new Set(input.taskIds)];
    const imported = await this.workOrders.importedSources(input.projectId, "productive", taskIds);
    const fresh = taskIds.filter((id) => !imported.has(id));
    const tasks = await mapLimit(fresh, IMPORT_CONCURRENCY, (id) => this.client.task(auth, id));
    return this.workOrders.importIntoBacklog(
      input.projectId,
      tasks.map((task) => toImport(row, task)),
    );
  }

  private async auth(): Promise<{ auth: ProductiveAuth; row: ProductiveConnectionRow }> {
    const row = await this.repository.find(this.database.db);
    if (!row)
      throw new ProductiveNotConnectedError(
        "Productive isn't connected. Add a token in Settings → Integrations.",
      );
    return { auth: { token: row.token, organizationId: row.organizationId }, row };
  }
}

function toConnection(row: ProductiveConnectionRow): ProductiveConnection {
  return {
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    personName: row.personName,
    tokenHint: maskApiKey(row.token),
    organizations: row.organizations,
    connectedAt: iso(row.connectedAt),
  };
}

function toImport(row: ProductiveConnectionRow, task: ProductiveTaskRecord) {
  return {
    title: task.title.trim().slice(0, TITLE_MAX) || `Task ${task.id}`,
    description: task.description ? htmlToMarkdown(task.description).slice(0, DESCRIPTION_MAX) : "",
    source: {
      provider: "productive" as const,
      id: task.id,
      number: task.number,
      url: taskUrl(row, task.id),
      projectName: task.projectName,
    },
  };
}

/** `https://app.productive.io/<org id>-<org slug>/task/<id>`, as Productive builds it. */
export function taskUrl(
  organization: { organizationId: string; organizationName: string },
  taskId: string,
): string {
  const slug = parameterize(organization.organizationName);
  const org = slug ? `${organization.organizationId}-${slug}` : organization.organizationId;
  return `https://app.productive.io/${org}/task/${encodeURIComponent(taskId)}`;
}

/** Rails' `parameterize`: ASCII, lowercase, runs of anything else become one dash. */
export function parameterize(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Maps with at most `limit` promises in flight; results keep the input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Map<number, R>();
  const queue = [...items.entries()];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const [index, item] = entry;
      results.set(index, await fn(item));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return [...results.entries()].toSorted(([a], [b]) => a - b).map(([, result]) => result);
}
