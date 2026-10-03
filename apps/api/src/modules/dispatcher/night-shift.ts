/** "HH:MM" → minutes after local midnight. */
function minutes(clock: string): number {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
}

/** True when `now` (local time) is inside [start, end); windows may wrap midnight. */
export function inWindow(now: Date, start: string, end: string): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutes(start);
  const to = minutes(end);
  if (from === to) return true;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

/** Next local occurrence of `clock` strictly after `now`. */
export function nextOccurrence(now: Date, clock: string): Date {
  const target = new Date(now);
  const total = minutes(clock);
  target.setHours(Math.floor(total / 60), total % 60, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}
