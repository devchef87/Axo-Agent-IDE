// Schedules for cron watches, in the node's local time zone. No dependency.
//   5-field cron:  "m h dom mon dow"   with *, lists (1,5), ranges (1-5), steps (*/15, 0-30/10),
//                  month/day names (jan, mon), dow 0 or 7 = Sunday.
//                  As in cron, if both day-of-month and day-of-week are restricted, either may match.
//   aliases:       @hourly @daily @midnight @weekly @monthly @yearly @annually
//   intervals:     "@every 30m" (min 1m; runs at creation + n·interval)

export interface Schedule {
  kind: 'cron' | 'every';
  expr: string;
  /** Next run strictly after `after` (ms). */
  next(after: number): number;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class ScheduleError extends Error {}

export function parseSchedule(raw: string, anchor = Date.now()): Schedule {
  const expr = raw.trim().replace(/\s+/g, ' ');
  const every = /^@every (\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(expr);
  if (every) {
    const ms = Number(every[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[every[2].toLowerCase() as 'm' | 'h' | 'd'];
    if (!(ms >= 60_000)) throw new ScheduleError('@every needs at least 1m');
    return { kind: 'every', expr, next: (after) => anchor + (Math.floor((after - anchor) / ms) + 1) * ms };
  }
  const parts = (ALIASES[expr.toLowerCase()] ?? expr).split(' ');
  if (parts.length !== 5) throw new ScheduleError(`"${raw}" is not a schedule: use 5 cron fields (m h dom mon dow), @daily-style aliases, or "@every 30m"`);
  const minute = field(parts[0], 0, 59, 'minute');
  const hour = field(parts[1], 0, 23, 'hour');
  const dom = field(parts[2], 1, 31, 'day of month');
  const month = field(parts[3], 1, 12, 'month', MONTHS, 1);
  const dow = field(parts[4], 0, 7, 'day of week', DAYS, 0);
  if (dow.set.has(7)) dow.set.add(0);
  const dayOk = (d: Date) => {
    const a = dom.set.has(d.getDate());
    const b = dow.set.has(d.getDay());
    if (dom.any && dow.any) return true;
    if (dom.any) return b;
    if (dow.any) return a;
    return a || b;
  };
  return {
    kind: 'cron', expr,
    next(after) {
      const d = new Date(after);
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() + 1);
      const limit = after + 5 * 366 * 86_400_000;
      while (d.getTime() <= limit) {
        if (!month.set.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
        if (!dayOk(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
        if (!hour.set.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
        if (!minute.set.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
        return d.getTime();
      }
      throw new ScheduleError(`"${raw}" never fires`);
    },
  };
}

function field(src: string, lo: number, hi: number, name: string, names?: string[], nameBase = 0): { set: Set<number>; any: boolean } {
  const set = new Set<number>();
  const val = (s: string): number => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + nameBase : Number(s);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ScheduleError(`bad ${name} "${s}" (allowed ${lo}-${hi})`);
    return n;
  };
  for (const item of src.split(',')) {
    const [range, stepStr] = item.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`bad step in ${name} "${item}"`);
    let a: number;
    let b: number;
    if (range === '*') { a = lo; b = hi; }
    else if (range.includes('-')) { const [x, y] = range.split('-'); a = val(x); b = val(y); }
    else { a = val(range); b = stepStr === undefined ? a : hi; }
    if (a > b) throw new ScheduleError(`bad range in ${name} "${item}"`);
    for (let n = a; n <= b; n += step) set.add(n);
  }
  return { set, any: src === '*' };
}
