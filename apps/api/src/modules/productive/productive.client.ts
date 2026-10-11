import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  ProductiveForbiddenError,
  ProductiveNotFoundError,
  ProductiveRateLimitedError,
  ProductiveTokenInvalidError,
  ProductiveUnavailableError,
} from "./productive.errors";

const API = "https://api.productive.io/api/v2";
const TIMEOUT_MS = 10_000;

/** What every call needs: the token, and the organization for tenanted endpoints. */
export interface ProductiveAuth {
  token: string;
  organizationId: string;
}

export interface ProductiveMembership {
  organization: { id: string; name: string };
  person: { id: string; name: string | null } | null;
}

export interface ProductiveTaskRecord {
  id: string;
  number: string | null;
  title: string;
  /** HTML (Productive sanitises it); null when empty. */
  description: string | null;
  projectName: string | null;
  status: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  updatedAt: string | null;
}

export interface ProductiveTaskFilter {
  projectId?: string | undefined;
  query?: string | undefined;
  assigneeId?: string | undefined;
  page: number;
  pageSize: number;
}

/** A JSON:API resource as Productive sends it; only what YugoTool reads. */
const resourceSchema = z.object({
  id: z.coerce.string(),
  type: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  relationships: z
    .record(
      z.string(),
      z.object({
        data: z
          .union([z.object({ id: z.coerce.string(), type: z.string() }), z.array(z.unknown())])
          .nullish(),
      }),
    )
    .optional(),
});
type Resource = z.infer<typeof resourceSchema>;

const documentSchema = z.object({
  data: z.union([resourceSchema, z.array(resourceSchema)]),
  included: z.array(resourceSchema).optional(),
  meta: z.object({ total_pages: z.number().optional() }).loose().optional(),
});
type Document = z.infer<typeof documentSchema>;

const errorBodySchema = z.object({
  errors: z.array(z.object({ detail: z.string().optional(), title: z.string().optional() })),
});

/**
 * Productive's public API (JSON:API, `X-Auth-Token`). Read-only: YugoTool
 * never writes to Productive (spec 0019). Swapped for a fake in tests.
 */
@Injectable()
export class ProductiveClient {
  /** Every organization the token reaches, with the token owner's person there. */
  async memberships(token: string): Promise<ProductiveMembership[]> {
    // Not tenanted: works without X-Organization-Id. `include` must be explicit,
    // or a token session gets no `included` at all.
    const doc = await this.get({ token }, "/organization_memberships", {
      include: "organization,person",
      "page[size]": "200",
    });
    return list(doc).flatMap((membership) => {
      const organization = related(doc, membership, "organization");
      if (!organization) return [];
      const person = related(doc, membership, "person");
      return [
        {
          organization: {
            id: organization.id,
            name: text(organization, "name") ?? organization.id,
          },
          person: person ? { id: person.id, name: personName(person) } : null,
        },
      ];
    });
  }

  /** Active projects, by name. */
  async projects(
    auth: ProductiveAuth,
    query: string | undefined,
  ): Promise<{ id: string; name: string; number: string | null }[]> {
    const doc = await this.get(auth, "/projects", {
      "filter[status]": "1",
      ...(query ? { "filter[query]": query } : {}),
      sort: "name",
      "page[size]": "200",
    });
    return list(doc).map((project) => ({
      id: project.id,
      name: text(project, "name") ?? project.id,
      number: text(project, "project_number") ?? text(project, "number"),
    }));
  }

  /** Open tasks, most recently updated first. */
  async tasks(
    auth: ProductiveAuth,
    filter: ProductiveTaskFilter,
  ): Promise<{ items: ProductiveTaskRecord[]; nextPage: number | null }> {
    const doc = await this.get(auth, "/tasks", {
      "filter[status]": "1",
      ...(filter.projectId ? { "filter[project_id]": filter.projectId } : {}),
      ...(filter.query ? { "filter[query]": filter.query } : {}),
      ...(filter.assigneeId ? { "filter[assignee_id]": filter.assigneeId } : {}),
      include: "project,assignee,workflow_status",
      sort: "-updated_at",
      "page[number]": String(filter.page),
      "page[size]": String(filter.pageSize),
    });
    const totalPages = doc.meta?.total_pages ?? 1;
    return {
      items: list(doc).map((task) => toTask(doc, task)),
      nextPage: filter.page < totalPages ? filter.page + 1 : null,
    };
  }

  async task(auth: ProductiveAuth, id: string): Promise<ProductiveTaskRecord> {
    const doc = await this.get(auth, `/tasks/${encodeURIComponent(id)}`, {
      include: "project,assignee,workflow_status",
    });
    const [task] = list(doc);
    if (!task) throw new ProductiveNotFoundError(`Productive has no task ${id}.`);
    return toTask(doc, task);
  }

  private async get(
    auth: { token: string; organizationId?: string },
    path: string,
    params: Record<string, string>,
  ): Promise<Document> {
    const url = `${API}${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          "X-Auth-Token": auth.token,
          ...(auth.organizationId ? { "X-Organization-Id": auth.organizationId } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProductiveUnavailableError(
        `Couldn't reach Productive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) throw productiveError(res.status, await res.text().catch(() => ""));
    const parsed = documentSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      throw new ProductiveUnavailableError("Productive sent a response YugoTool can't read.");
    return parsed.data;
  }
}

/** Maps a failed response to a domain error; the body's JSON:API `errors` give the detail. */
export function productiveError(status: number, body: string): Error {
  const detail = errorDetail(body);
  if (status === 401)
    return new ProductiveTokenInvalidError(
      "Productive didn't accept this token. Check it was copied whole and isn't revoked.",
    );
  if (status === 403)
    return new ProductiveForbiddenError(
      detail ?? "Productive denied access. The token's owner may not be in this organization.",
    );
  if (status === 404) return new ProductiveNotFoundError(detail ?? "Productive couldn't find it.");
  if (status === 429)
    return new ProductiveRateLimitedError(
      "Productive's rate limit was reached. Try again shortly.",
    );
  return new ProductiveUnavailableError(
    `Productive answered ${status}${detail ? `: ${detail}` : "."}`,
  );
}

function errorDetail(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = errorBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const details = parsed.data.errors.map((e) => e.detail ?? e.title).filter(Boolean);
  return details.length ? details.join("; ") : null;
}

function list(doc: Document): Resource[] {
  return Array.isArray(doc.data) ? doc.data : [doc.data];
}

function related(doc: Document, resource: Resource, name: string): Resource | null {
  const ref = resource.relationships?.[name]?.data;
  if (!ref || Array.isArray(ref)) return null;
  return doc.included?.find((r) => r.type === ref.type && r.id === ref.id) ?? null;
}

function text(resource: Resource, key: string): string | null {
  const value = resource.attributes?.[key];
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number") return String(value);
  return null;
}

function personName(person: Resource): string | null {
  const name = [text(person, "first_name"), text(person, "last_name")].filter(Boolean).join(" ");
  return name || text(person, "name");
}

function toTask(doc: Document, task: Resource): ProductiveTaskRecord {
  const assignee = related(doc, task, "assignee");
  return {
    id: task.id,
    number: text(task, "task_number") ?? text(task, "number"),
    title: text(task, "title") ?? `Task ${task.id}`,
    description: text(task, "description"),
    projectName: (() => {
      const project = related(doc, task, "project");
      return project ? text(project, "name") : null;
    })(),
    status: (() => {
      const status = related(doc, task, "workflow_status");
      return status ? text(status, "name") : null;
    })(),
    assigneeName: assignee ? personName(assignee) : null,
    dueDate: text(task, "due_date"),
    updatedAt: text(task, "updated_at"),
  };
}
