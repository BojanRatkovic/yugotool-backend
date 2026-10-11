import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkOrder } from "@yugotool/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoProblem, splitProblem } from "../src/modules/work-orders/hub-work";
import {
  WorkOrderNotSplittableError,
  WorkOrderRepoInvalidError,
} from "../src/modules/work-orders/work-order.errors";
import { WorkOrdersService } from "../src/modules/work-orders/work-orders.service";

const root = mkdtempSync(path.join(os.tmpdir(), "yugotool-api-split-"));
const hub = path.join(root, "hub");
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(() => {
  writeFileSync(path.join(root, "CLAUDE.md"), "");
  mkdirSync(path.join(hub, "repos"), { recursive: true });
  writeFileSync(path.join(hub, "CLAUDE.md"), "# hub\n");
  for (const name of ["api", "web"]) {
    const dir = path.join(hub, "repos", name);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }
});

const HUB_PROJECT = "11111111-1111-4111-8111-111111111111";
const REPO_PROJECT = "22222222-2222-4222-8222-222222222222";

/** In-memory stand-in for WorkOrdersRepository (no Postgres in API tests). */
class MemoryWorkOrders {
  rows = new Map<string, WorkOrder>();
  async find(_db: unknown, id: string) {
    return this.rows.get(id) ?? null;
  }
  async projectOf(_db: unknown, projectId: string) {
    if (projectId === HUB_PROJECT) return { kind: "hub" as const, repoPath: hub };
    return { kind: "repo" as const, repoPath: root };
  }
  async nextPosition() {
    return this.rows.size + 1;
  }
  async followers(_db: unknown, id: string) {
    const chain: WorkOrder[] = [];
    let previous = id;
    for (;;) {
      const next = [...this.rows.values()].find((w) => w.followsId === previous);
      if (!next) return chain;
      chain.push(next);
      previous = next.id;
    }
  }
  async insert(_db: unknown, values: Partial<WorkOrder> & { projectId: string; title: string }) {
    const now = new Date().toISOString();
    const row: WorkOrder = {
      id: values.id ?? crypto.randomUUID(),
      projectId: values.projectId,
      kind: "build",
      title: values.title,
      description: values.description ?? "",
      pullRequest: null,
      status: "backlog",
      stationKey: null,
      position: values.position ?? 0,
      repo: values.repo ?? null,
      followsId: values.followsId ?? null,
      branch: null,
      currentRunId: null,
      modelOverride: null,
      effortOverride: null,
      maxBudgetUsd: null,
      prUrl: null,
      ci: null,
      queueMode: null,
      queuedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async update(_db: unknown, id: string, patch: Partial<WorkOrder>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }
}

function service() {
  const repository = new MemoryWorkOrders();
  const database = { db: {}, transaction: (fn: (tx: unknown) => unknown) => fn({}) };
  const svc = new WorkOrdersService(
    database as never,
    repository as never,
    { publish: async () => undefined } as never,
    {} as never,
  );
  return { svc, repository };
}

const items = [
  { title: "Add endpoint", description: "1. route", repo: "api" },
  { title: "Use endpoint", description: "1. call it", repo: "web" },
  { title: "Docs", description: "1. write", repo: "api" },
];

describe("hub work orders (spec 0014)", () => {
  it("create takes a preset repo of the hub; repo projects take none", async () => {
    const { svc } = service();
    const wo = await svc.create({
      projectId: HUB_PROJECT,
      title: "Fix",
      description: "",
      repo: "web",
    });
    expect(wo.repo).toBe("web");
    await expect(
      svc.create({ projectId: HUB_PROJECT, title: "Fix", description: "", repo: "nope" }),
    ).rejects.toBeInstanceOf(WorkOrderRepoInvalidError);
    await expect(
      svc.create({ projectId: REPO_PROJECT, title: "Fix", description: "", repo: "web" }),
    ).rejects.toBeInstanceOf(WorkOrderRepoInvalidError);
    const plain = await svc.create({ projectId: REPO_PROJECT, title: "Fix", description: "" });
    expect(plain).toMatchObject({ repo: null, followsId: null });
  });

  it("split keeps item 1 here and chains the rest in the backlog", async () => {
    const { svc } = service();
    const wo = await svc.create({
      projectId: HUB_PROJECT,
      title: "Paging everywhere",
      description: "",
    });
    const chain = await svc.split(wo.id, { items });
    expect(chain.map((w) => [w.title, w.repo, w.status])).toEqual([
      ["Paging everywhere", "api", "backlog"],
      ["Use endpoint", "web", "backlog"],
      ["Docs", "api", "backlog"],
    ]);
    expect(chain[1]?.followsId).toBe(wo.id);
    expect(chain[2]?.followsId).toBe(chain[1]?.id);
    expect(chain[1]?.description).toBe("1. call it");

    const again = await svc.split(wo.id, { items });
    expect(again.map((w) => w.id)).toEqual(chain.map((w) => w.id));
  });

  it("refuses a split on a repo project, with an unknown repo, or when done", async () => {
    const { svc, repository } = service();
    const plain = await svc.create({ projectId: REPO_PROJECT, title: "x", description: "" });
    await expect(svc.split(plain.id, { items })).rejects.toBeInstanceOf(
      WorkOrderNotSplittableError,
    );
    const wo = await svc.create({ projectId: HUB_PROJECT, title: "x", description: "" });
    await expect(
      svc.split(wo.id, { items: [items[0]!, { ...items[1]!, repo: "nope" }] }),
    ).rejects.toBeInstanceOf(WorkOrderNotSplittableError);
    await repository.update({}, wo.id, { status: "done" });
    await expect(svc.split(wo.id, { items })).rejects.toBeInstanceOf(WorkOrderNotSplittableError);
  });

  it("pure rules", () => {
    const hubRepos = { kind: "hub" as const, repos: ["api", "web"] };
    expect(repoProblem(hubRepos, null)).toBeNull();
    expect(repoProblem({ kind: "repo", repos: [] }, undefined)).toBeNull();
    expect(splitProblem({ kind: "review", status: "backlog" }, hubRepos, items)).toMatch(/build/);
  });
});
