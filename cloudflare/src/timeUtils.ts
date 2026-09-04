/**
 * Pure, dependency-free time/schedule helpers -- the TypeScript twin of the
 * Railway version's time_utils.py. Everything takes `now` as an explicit
 * argument instead of reading the system clock internally, so the weekly
 * schedule logic is unit-testable with fixed timestamps.
 *
 * Because Europe/Moscow has been a fixed UTC+3 offset with no seasonal
 * changes since 2014, all of this works with plain arithmetic on
 * millisecond timestamps -- no timezone database / Intl API is needed
 * (Workers don't ship a full ICU timezone database by default anyway).
 */
import { MOSCOW_UTC_OFFSET_MINUTES, WEEKLY_SCHEDULE, type ScheduleEntry } from "./config";

const OFFSET_MS = MOSCOW_UTC_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** A Date whose *UTC* fields equal Europe/Moscow's local wall-clock fields. */
function toMoscowShifted(date: Date): Date {
  return new Date(date.getTime() + OFFSET_MS);
}

/** "YYYY-MM-DD" for the Moscow calendar date containing `date`. */
export function moscowDateKey(date: Date): string {
  const shifted = toMoscowShifted(date);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Python's date.weekday() convention: Monday=0 .. Sunday=6. */
export function moscowWeekday(date: Date): number {
  const shifted = toMoscowShifted(date);
  return (shifted.getUTCDay() + 6) % 7; // JS getUTCDay(): Sunday=0 -> remap
}

/**
 * (scheduledAt, opensAt) -- both real UTC instants -- for the occurrence of
 * `entry` in the ISO week (Mon-Sun, Europe/Moscow) that contains `now`.
 */
export function weekOccurrence(now: Date, entry: ScheduleEntry): { scheduledAt: Date; opensAt: Date } {
  const shiftedNow = toMoscowShifted(now);
  const shiftedWeekday = (shiftedNow.getUTCDay() + 6) % 7;
  const mondayShiftedMs = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate() - shiftedWeekday,
  );
  const dayShifted = new Date(mondayShiftedMs + entry.weekday * DAY_MS);

  const scheduledShiftedMs = Date.UTC(
    dayShifted.getUTCFullYear(),
    dayShifted.getUTCMonth(),
    dayShifted.getUTCDate(),
    entry.classHour,
    entry.classMinute,
  );
  const opensShiftedMs = Date.UTC(
    dayShifted.getUTCFullYear(),
    dayShifted.getUTCMonth(),
    dayShifted.getUTCDate(),
    entry.opensHour,
    entry.opensMinute,
  );

  return {
    scheduledAt: new Date(scheduledShiftedMs - OFFSET_MS),
    opensAt: new Date(opensShiftedMs - OFFSET_MS),
  };
}

export interface WeekOccurrence {
  entry: ScheduleEntry;
  scheduledAt: Date;
  opensAt: Date;
}

/** All configured schedule entries' occurrences for the week containing `now`. */
export function allWeekOccurrences(now: Date): WeekOccurrence[] {
  return WEEKLY_SCHEDULE.map((entry) => {
    const { scheduledAt, opensAt } = weekOccurrence(now, entry);
    return { entry, scheduledAt, opensAt };
  });
}

/**
 * "DD.MM.YYYY HH:MM" for the Europe/Moscow wall-clock time of `date` --
 * used for the admin one-off consultation flow (see bot/handlers/admin.ts),
 * both to show the curator what they're about to create/cancel and to
 * label the resulting broadcast/notification.
 */
export function formatMoscowDateTime(date: Date): string {
  const shifted = toMoscowShifted(date);
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = shifted.getUTCFullYear();
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

const MOSCOW_DATETIME_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,T]+(\d{1,2}):(\d{2})$/;

/**
 * Parses "DD.MM.YYYY HH:MM" as Europe/Moscow local time, returning the
 * matching UTC instant -- or null if the text doesn't match the format, or
 * names an impossible calendar date/time (e.g. 31.02.2026, or 25:00).
 * `Date.UTC` silently rolls invalid component values over into the next
 * day/month rather than rejecting them, so the parsed result is round-
 * tripped back through `toMoscowShifted` and compared to the typed digits
 * to catch that case.
 */
export function parseMoscowDateTime(text: string): Date | null {
  const m = MOSCOW_DATETIME_RE.exec(text.trim());
  if (m === null) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;

  const result = new Date(Date.UTC(year, month - 1, day, hour, minute) - OFFSET_MS);
  const roundTrip = toMoscowShifted(result);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return result;
}
