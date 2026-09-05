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
import { MOSCOW_UTC_OFFSET_MINUTES, type ScheduleEntry } from "./config";

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

/** `entries`' occurrences for the week containing `now` -- `entries` comes
 * from D1 in production (db/schedule.ts's listActiveScheduleEntries(), see
 * db/consultations.ts's reconcile()), so this function itself stays pure
 * and easy to unit-test with a fixed fixture array. */
export function allWeekOccurrences(now: Date, entries: ScheduleEntry[]): WeekOccurrence[] {
  return entries.map((entry) => {
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

/**
 * "HH:MM" for the Europe/Moscow wall-clock time of `date` -- used wherever
 * only the class start time matters, not the full date (the opening
 * broadcast, the queue header -- see bot/texts.ts's queueHeader()).
 */
export function formatMoscowTime(date: Date): string {
  const shifted = toMoscowShifted(date);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
}

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})$/;

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** Parses "ЧЧ:ММ" (Europe/Moscow wall-clock time-of-day, no date) -- used by
 * the admin "📅 Еженедельный график" flow (bot/handlers/admin.ts) when
 * adding a new weekly slot, where only a recurring time-of-day is needed,
 * not a specific calendar date/time (see parseMoscowDateTime below for
 * that). Returns null for anything that doesn't match, or names an
 * impossible hour/minute. */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const m = TIME_OF_DAY_RE.exec(text.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** "ЧЧ:ММ" for a TimeOfDay -- the mirror of parseTimeOfDay above, used to
 * echo a chosen/stored time back in confirmation and list messages. */
export function formatTimeOfDay(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/**
 * Registration-opens time for a new weekly slot, one hour before class --
 * same lead time as the regular schedule and admin one-off consultations
 * (config.ADMIN_CONSULTATION_LEAD_MS). Clamped at 00:00 the same day rather
 * than rolling back into the previous day, since a weekly_schedule entry's
 * opens_hour/opens_minute is always "same day as class" by design (see
 * migrations/0004_weekly_schedule.sql) -- this only matters for a class
 * scheduled in the first hour after midnight, an edge case rare enough to
 * just clamp rather than support crossing into the previous weekday.
 */
export function openTimeOneHourBefore(classTime: TimeOfDay): TimeOfDay {
  const totalMinutes = classTime.hour * 60 + classTime.minute - 60;
  if (totalMinutes < 0) return { hour: 0, minute: 0 };
  return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
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
