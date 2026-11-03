// When a scheduled task is due. Missed while the computer was off, it runs once at the next chance;
// it never piles up.
export interface TaskTiming {
  frequency?: unknown;
  at?: unknown;
  last_run?: unknown;
  paused?: unknown;
}

const dayMs = 86_400_000;

const clockOf = (at: unknown): [number, number] => {
  const m = typeof at === "string" ? /^(\d{1,2}):(\d{2})$/.exec(at.trim()) : null;
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
};

const atDay = (d: Date, [h, min]: [number, number]) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min).getTime();

export function isDue(task: TaskTiming, now: Date): boolean {
  if (task.paused === true) return false;
  const clock = clockOf(task.at);
  if (now.getTime() < atDay(now, clock)) return false;
  const last = typeof task.last_run === "string" ? new Date(task.last_run) : null;
  if (!last || Number.isNaN(last.getTime())) return true;
  if (task.frequency === "monthly")
    return now.getFullYear() * 12 + now.getMonth() > last.getFullYear() * 12 + last.getMonth();
  const days = Math.round((atDay(now, [12, 0]) - atDay(last, [12, 0])) / dayMs);
  return days >= (task.frequency === "weekly" ? 7 : 1);
}
