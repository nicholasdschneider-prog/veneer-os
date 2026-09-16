import { CronExpressionParser } from 'cron-parser';

export type ScheduleSpec =
  | { type: 'once'; runAt: string }
  | { type: 'daily'; time: string }
  | { type: 'weekdays'; time: string }
  | { type: 'weekly'; time: string; weekday: number }
  | { type: 'cron'; expression: string };

export const DEFAULT_SCHEDULE_TIME_ZONE = 'America/New_York';

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const formatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

function cronExpression(spec: Exclude<ScheduleSpec, { type: 'once' }>): string {
  if (spec.type === 'cron') return spec.expression.trim();
  const [hour, minute] = spec.time.split(':');
  if (spec.type === 'daily') return `${minute} ${hour} * * *`;
  if (spec.type === 'weekdays') return `${minute} ${hour} * * 1-5`;
  return `${minute} ${hour} * * ${spec.weekday}`;
}

export function isValidCronExpression(expression: string): boolean {
  const value = expression.trim();
  // Scheduled agents are minute-granularity. Reject optional seconds and
  // non-deterministic Jenkins H values so a saved task always means one thing.
  if (value.split(/\s+/).length !== 5 || /(?:^|[^A-Za-z])H(?:[^A-Za-z]|$)/i.test(value)) return false;
  try {
    CronExpressionParser.parse(value, { currentDate: new Date(), tz: 'UTC' }).next();
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function isScheduleSpec(value: unknown): value is ScheduleSpec {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'once') return typeof v.runAt === 'string' && Number.isFinite(new Date(v.runAt).getTime());
  if (v.type === 'daily' || v.type === 'weekdays') return typeof v.time === 'string' && TIME_RE.test(v.time);
  if (v.type === 'cron') return typeof v.expression === 'string' && isValidCronExpression(v.expression);
  return (
    v.type === 'weekly' &&
    typeof v.time === 'string' &&
    TIME_RE.test(v.time) &&
    Number.isInteger(v.weekday) &&
    Number(v.weekday) >= 0 &&
    Number(v.weekday) <= 6
  );
}

export function parseScheduleSpec(json: string): ScheduleSpec {
  const value: unknown = JSON.parse(json);
  if (!isScheduleSpec(value)) throw new Error('Invalid schedule');
  return value;
}

function localParts(date: Date, timeZone: string): { hour: number; minute: number; weekday: number; dateKey: string } {
  let formatter = formatterByTimeZone.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterByTimeZone.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const take = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    hour: Number(take('hour')),
    minute: Number(take('minute')),
    weekday: DAY_SHORT.indexOf(take('weekday') as (typeof DAY_SHORT)[number]),
    dateKey: `${take('year')}-${take('month')}-${take('day')}`,
  };
}

export function nextOccurrence(spec: ScheduleSpec, timeZone: string, after: Date): Date | null {
  if (!isValidTimeZone(timeZone)) throw new Error('Invalid timezone');
  if (spec.type === 'once') {
    const runAt = new Date(spec.runAt);
    return runAt.getTime() > after.getTime() ? runAt : null;
  }

  if (spec.type === 'cron') {
    const expression = cronExpression(spec);
    if (!isValidCronExpression(expression)) throw new Error('Invalid cron expression');
    return CronExpressionParser.parse(expression, { currentDate: after, tz: timeZone }).next().toDate();
  }

  // Preserve the legacy simple-schedule behavior: scan UTC minutes for the
  // requested local time, skip nonexistent spring-forward minutes, and do not
  // repeat a fall-back minute. Existing automations must not change semantics.
  const [wantHour, wantMinute] = spec.time.split(':').map(Number) as [number, number];
  const afterLocal = localParts(after, timeZone);
  const afterAlreadyRanThisLocalMinute = afterLocal.hour === wantHour && afterLocal.minute === wantMinute;
  const first = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const maxMinutes = 8 * 24 * 60 + 60;
  for (let offset = 0; offset <= maxMinutes; offset++) {
    const candidate = new Date(first + offset * 60_000);
    const local = localParts(candidate, timeZone);
    if (local.hour !== wantHour || local.minute !== wantMinute) continue;
    if (afterAlreadyRanThisLocalMinute && local.dateKey === afterLocal.dateKey) continue;
    if (spec.type === 'weekdays' && (local.weekday === 0 || local.weekday === 6)) continue;
    if (spec.type === 'weekly' && local.weekday !== spec.weekday) continue;
    return candidate;
  }
  throw new Error('Could not calculate the next run');
}

export function nextOccurrences(spec: ScheduleSpec, timeZone: string, after: Date, count: number): Date[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Invalid occurrence count');
  if (!isValidTimeZone(timeZone)) throw new Error('Invalid timezone');
  if (spec.type === 'once') {
    const next = nextOccurrence(spec, timeZone, after);
    return next ? [next] : [];
  }
  if (spec.type !== 'cron') {
    const results: Date[] = [];
    let cursor = after;
    for (let index = 0; index < count; index++) {
      const next = nextOccurrence(spec, timeZone, cursor);
      if (!next) break;
      results.push(next);
      cursor = next;
    }
    return results;
  }
  const expression = cronExpression(spec);
  if (!isValidCronExpression(expression)) throw new Error('Invalid cron expression');
  return CronExpressionParser.parse(expression, { currentDate: after, tz: timeZone })
    .take(count)
    .map((date) => date.toDate());
}

export function describeSchedule(spec: ScheduleSpec, timeZone: string): string {
  if (spec.type === 'once') {
    return `Once on ${new Intl.DateTimeFormat('en-US', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(spec.runAt))}`;
  }
  if (spec.type === 'cron') return `Cron: ${spec.expression.trim()}`;
  const [hour, minute] = spec.time.split(':').map(Number) as [number, number];
  const at = `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  if (spec.type === 'daily') return `Every day at ${at}`;
  if (spec.type === 'weekdays') return `Weekdays at ${at}`;
  return `Every ${DAY_NAMES[spec.weekday]} at ${at}`;
}
