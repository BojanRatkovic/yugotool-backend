// Pure helpers for hub runs (spec 0014) — deterministic, no I/O.
import type { Station } from "@zastava/contracts";

/** The first station that edits code; the worktree must exist before it. */
export function firstEditIndex(stations: Station[]): number {
  return stations.findIndex((s) => (s.kind === "agent" && s.canEdit) || s.kind === "shift");
}

/**
 * The planning station of a hub run: the first read-only agent before the
 * first editing station. It returns the plan with the repo (and a split).
 * -1 when the line has none.
 */
export function hubPlanIndex(stations: Station[]): number {
  const edit = firstEditIndex(stations);
  const end = edit < 0 ? stations.length : edit;
  return stations.slice(0, end).findIndex((s) => s.kind === "agent" && !s.canEdit);
}

/** A read-only agent before the first editing station runs in the hub itself. */
export function runsInHub(stations: Station[], index: number): boolean {
  const station = stations[index];
  const edit = firstEditIndex(stations);
  return station?.kind === "agent" && !station.canEdit && (edit < 0 || index < edit);
}

/**
 * A hub run needs its repo's worktree before this station: anything but a
 * station that runs in the hub or a gate before the first editing station
 * (the plan gate). So the workspace comes after the plan gate, or right after
 * Research when there is no gate in between.
 */
export function needsWorkspace(stations: Station[], index: number): boolean {
  const station = stations[index];
  if (!station) return false;
  if (runsInHub(stations, index)) return false;
  const edit = firstEditIndex(stations);
  return !(station.kind === "gate" && (edit < 0 || index < edit));
}
