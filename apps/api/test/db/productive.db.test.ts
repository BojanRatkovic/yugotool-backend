import { createDbClient, type DbClient, projects } from "@yugotool/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ProductiveClient,
  ProductiveMembership,
  ProductiveTaskRecord,
} from "../../src/modules/productive/productive.client";
import {
  ProductiveNotConnectedError,
  ProductiveOrganizationUnknownError,
  ProductivePickOrganizationError,
  ProductiveTokenInvalidError,
} from "../../src/modules/productive/productive.errors";
import { ProductiveRepository } from "../../src/modules/productive/productive.repository";
import { ProductiveService } from "../../src/modules/productive/productive.service";
import { WorkOrdersRepository } from "../../src/modules/work-orders/work-orders.repository";
import { WorkOrdersService } from "../../src/modules/work-orders/work-orders.service";
import { testDatabaseUrl } from "./test-database";

const PROJECT = "00000000-0000-4000-8000-000000000019";

const task = (id: string, extra: Partial<ProductiveTaskRecord> = {}): ProductiveTaskRecord => ({
  id,
  number: `#${id}`,
  title: `Task ${id}`,
  description: `<p>Do <strong>${id}</strong></p>`,
  projectName: "Website",
  status: "To do",
  assigneeName: "Ana Anić",
  dueDate: null,
  updatedAt: "2026-10-11T10:00:00.000Z",
  ...extra,
});

/** Productive as the token "good" (one org), "multi" (two orgs) or anything else (401) sees it. */
class FakeProductive {
  taskCalls: string[] = [];
  lastFilter: unknown = null;

  memberships(token: string): Promise<ProductiveMembership[]> {
    const acme = {
      organization: { id: "1", name: "Acme" },
      person: { id: "p1", name: "Ana Anić" },
    };
    if (token === "good") return Promise.resolve([acme]);
    if (token === "multi")
      return Promise.resolve([
        acme,
        { organization: { id: "2", name: "Beta" }, person: { id: "p2", name: "Ana" } },
      ]);
    return Promise.reject(new ProductiveTokenInvalidError("rejected"));
  }

  projects() {
    return Promise.resolve([{ id: "10", name: "Website", number: "7" }]);
  }

  tasks(_auth: unknown, filter: unknown) {
    this.lastFilter = filter;
    return Promise.resolve({ items: [task("1"), task("2")], nextPage: 2 });
  }

  task(_auth: unknown, id: string) {
    this.taskCalls.push(id);
    return Promise.resolve(task(id));
  }
}

let client: DbClient;
let fake: FakeProductive;
let productive: ProductiveService;
const published: string[] = [];

beforeAll(async () => {
  client = createDbClient(testDatabaseUrl());
  const database = { db: client.db, transaction: client.db.transaction.bind(client.db) };
  const events = {
    publish: (event: { collection?: string }) => {
      published.push(event.collection ?? "");
      return Promise.resolve();
    },
  };
  fake = new FakeProductive();
  const workOrders = new WorkOrdersService(
    database as never,
    new WorkOrdersRepository(),
    events as never,
    {} as never,
  );
  productive = new ProductiveService(
    database as never,
    new ProductiveRepository(),
    fake as unknown as ProductiveClient,
    workOrders,
    events as never,
  );
});

afterAll(async () => {
  await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`DELETE FROM productive_connection`);
  await client.db.execute(sql`DELETE FROM projects WHERE id = ${PROJECT}`);
  await client.db.insert(projects).values({ id: PROJECT, name: "web", repoPath: "/tmp/web" });
  fake.taskCalls = [];
  published.length = 0;
});

describe("Productive connection (spec 0019)", () => {
  it("is null until connected, then never returns the token", async () => {
    expect(await productive.status()).toEqual({ connection: null });
    const connection = await productive.connect({ token: "good" });
    expect(connection).toMatchObject({
      organizationId: "1",
      organizationName: "Acme",
      personName: "Ana Anić",
      tokenHint: "…od",
    });
    expect(JSON.stringify(await productive.status())).not.toContain('"good"');
    expect(published).toContain("integrations");
  });

  it("asks to pick when the token reaches several organizations", async () => {
    const pick = productive.connect({ token: "multi" });
    await expect(pick).rejects.toBeInstanceOf(ProductivePickOrganizationError);
    await expect(pick).rejects.toMatchObject({
      details: {
        organizations: [
          { id: "1", name: "Acme" },
          { id: "2", name: "Beta" },
        ],
      },
    });
    await expect(
      productive.connect({ token: "multi", organizationId: "9" }),
    ).rejects.toBeInstanceOf(ProductiveOrganizationUnknownError);
    expect(
      (await productive.connect({ token: "multi", organizationId: "2" })).organizationName,
    ).toBe("Beta");
    // Switching organization reuses the saved token.
    expect((await productive.connect({ organizationId: "1" })).organizationName).toBe("Acme");
  });

  it("rejects a bad token and keeps nothing", async () => {
    await expect(productive.connect({ token: "nope" })).rejects.toBeInstanceOf(
      ProductiveTokenInvalidError,
    );
    expect(await productive.status()).toEqual({ connection: null });
  });

  it("needs a connection for projects, tasks and import", async () => {
    await expect(productive.projects({})).rejects.toBeInstanceOf(ProductiveNotConnectedError);
    await productive.connect({ token: "good" });
    await productive.disconnect();
    expect(await productive.status()).toEqual({ connection: null });
  });
});

describe("Productive tasks into the backlog", () => {
  beforeEach(async () => {
    await productive.connect({ token: "good" });
  });

  it("filters to the token owner's tasks and links each to Productive", async () => {
    const page = await productive.tasks({ projectId: PROJECT, mine: true, page: 1 });
    expect(fake.lastFilter).toMatchObject({ assigneeId: "p1", page: 1 });
    expect(page.nextPage).toBe(2);
    expect(page.items[0]).toMatchObject({
      id: "1",
      url: "https://app.productive.io/1-acme/task/1",
      workOrderId: null,
    });
    await productive.tasks({ projectId: PROJECT, mine: false, page: 1 });
    expect(fake.lastFilter).toMatchObject({ assigneeId: undefined });
  });

  it("imports tasks as backlog work orders, once per project", async () => {
    const [first, second] = await productive.import({ projectId: PROJECT, taskIds: ["1", "2"] });
    expect(first).toMatchObject({
      projectId: PROJECT,
      status: "backlog",
      title: "Task 1",
      description: "Do **1**",
      repo: null,
      source: {
        provider: "productive",
        id: "1",
        number: "#1",
        url: "https://app.productive.io/1-acme/task/1",
        projectName: "Website",
      },
    });
    expect(second?.position).toBeGreaterThan(first?.position ?? Infinity);
    expect(published).toContain("work_orders");

    // Again: task 1 is not fetched again and keeps its work order.
    fake.taskCalls = [];
    const again = await productive.import({ projectId: PROJECT, taskIds: ["1", "3"] });
    expect(fake.taskCalls).toEqual(["3"]);
    expect(again.map((w) => w.source?.id)).toEqual(["3"]);

    const page = await productive.tasks({ projectId: PROJECT, mine: true, page: 1 });
    expect(page.items.map((t) => t.workOrderId)).toEqual([first?.id, second?.id]);
  });
});
