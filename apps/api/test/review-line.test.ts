import type { Client } from "@temporalio/client";
import { type Line, type LineKind, REVIEW_LINE_STATIONS, type Station } from "@yugotool/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../src/core/database/database.service";
import type { EventsService } from "../src/core/events/events.service";
import { ProjectNotFoundError } from "../src/modules/projects/project.errors";
import type { ProjectsRepository } from "../src/modules/projects/projects.repository";
import { ProjectsService } from "../src/modules/projects/projects.service";

const PROJECT = "00000000-0000-4000-8000-000000000001";

/** In-memory lines keyed by kind, enough for the review-line paths. */
function setup(opts: { project?: boolean } = {}) {
  const lines = new Map<string, Line>();
  const now = new Date().toISOString();
  const repository = {
    find: vi.fn(async () => (opts.project === false ? null : { id: PROJECT })),
    findLine: vi.fn(
      async (_db: unknown, _id: string, kind: LineKind = "build") => lines.get(kind) ?? null,
    ),
    insertLine: vi.fn(
      async (_db: unknown, projectId: string, stations: Station[], kind: LineKind = "build") => {
        if (lines.has(kind)) return;
        lines.set(kind, {
          id: crypto.randomUUID(),
          projectId,
          kind,
          name: "Review line",
          stations,
          createdAt: now,
          updatedAt: now,
        });
      },
    ),
    updateLine: vi.fn(
      async (_db: unknown, _id: string, stations: Station[], kind: LineKind = "build") => {
        const line = lines.get(kind);
        if (!line) return null;
        const next = { ...line, stations };
        lines.set(kind, next);
        return next;
      },
    ),
  };
  const events = { publish: vi.fn(async () => undefined) };
  const service = new ProjectsService(
    { db: {} } as unknown as DatabaseService,
    repository as unknown as ProjectsRepository,
    events as unknown as EventsService,
    {} as Client,
  );
  return { service, repository, events };
}

describe("review line", () => {
  it("is seeded from the template on first read, once", async () => {
    const { service, repository } = setup();
    const first = await service.getReviewLine(PROJECT);
    const second = await service.getReviewLine(PROJECT);
    expect(first.kind).toBe("review");
    expect(first.stations).toEqual(REVIEW_LINE_STATIONS);
    expect(second.id).toBe(first.id);
    expect(repository.insertLine).toHaveBeenCalledTimes(1);
  });

  it("404s for an unknown project", async () => {
    const { service } = setup({ project: false });
    await expect(service.getReviewLine(PROJECT)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("updates the review line only and invalidates projects", async () => {
    const { service, repository, events } = setup();
    const stations = [{ ...REVIEW_LINE_STATIONS[0], name: "Strict review" }] as Station[];
    const line = await service.updateReviewLine(PROJECT, { stations });
    expect(line.stations[0]?.name).toBe("Strict review");
    expect(repository.updateLine).toHaveBeenCalledWith({}, PROJECT, stations, "review");
    expect(events.publish).toHaveBeenCalledWith({ type: "invalidate", collection: "projects" });
  });
});
