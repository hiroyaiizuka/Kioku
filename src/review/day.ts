import type { KiokuDay } from './types';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function parts(day: KiokuDay): [number, number, number] {
  const match = day.match(DAY_PATTERN);
  if (!match) throw new Error(`Invalid Kioku day: ${day}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isKiokuDay(value: unknown): value is KiokuDay {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const [year, month, date] = parts(value);
  const probe = new Date(Date.UTC(year, month - 1, date, 12));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === date;
}

/**
 * The Kioku day of a real instant: the local calendar date, where local times before
 * `dayStartHour` (default 4) still belong to the previous day. Uses local wall-clock fields only,
 * so daylight-saving shifts never move the boundary.
 */
export function kiokuDay(now: Date, dayStartHour: number): KiokuDay {
  let local = now;
  if (now.getHours() < dayStartHour) {
    local = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  }
  return `${pad(local.getFullYear(), 4)}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/**
 * The instant passed to ts-fsrs for a Kioku day: that date at 12:00 UTC. ts-fsrs counts elapsed
 * days as UTC calendar-day differences and adds whole 24-hour days, so with this normalisation its
 * day arithmetic equals Kioku-day arithmetic in every time zone, with or without DST.
 */
export function dayNoonUtc(day: KiokuDay): Date {
  const [year, month, date] = parts(day);
  return new Date(Date.UTC(year, month - 1, date, 12));
}

/** The UTC calendar date of an instant, as a Kioku day string. */
export function utcDay(instant: Date): KiokuDay {
  return `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
}

export function addDays(day: KiokuDay, days: number): KiokuDay {
  return utcDay(new Date(dayNoonUtc(day).getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: KiokuDay, to: KiokuDay): number {
  return Math.round((dayNoonUtc(to).getTime() - dayNoonUtc(from).getTime()) / MS_PER_DAY);
}
