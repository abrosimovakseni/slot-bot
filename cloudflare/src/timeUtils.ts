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
