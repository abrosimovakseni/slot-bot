/**
 * Central configuration. Nothing secret lives here -- BOT_TOKEN and the
 * webhook secret come from Cloudflare secrets (`wrangler secret put`), never
 * from source, never from wrangler.toml `[vars]`.
 *
 * The weekly schedule lives here in one place, same as the Railway
 * version's config.py -- change it here if the curator's schedule ever
 * changes, nothing else needs to change.
 */

export interface ScheduleEntry {
  name: string; // human label, e.g. "Среда" -- used in messages/logs only
  weekday: number; // 0=Monday .. 6=Sunday (Python date.weekday() convention)
  classHour: number;
  classMinute: number;
  opensHour: number;
  opensMinute: number;
}

export const WEEKLY_SCHEDULE: ScheduleEntry[] = [
  { name: "Среда", weekday: 2, classHour: 10, classMinute: 30, opensHour: 9, opensMinute: 30 },
  { name: "Пятница", weekday: 4, classHour: 10, classMinute: 30, opensHour: 9, opensMinute: 30 },
];

/** Size of the priority-reserved block at the top of the queue (positions 1..N). */
export const PRIORITY_SLOTS = 5;

/**
 * How long before class a one-off admin consultation (see
 * bot/handlers/admin.ts) opens for registration -- kept the same as the
 * regular Wed/Fri schedule's own 1-hour lead (WEEKLY_SCHEDULE above), so a
 * curator-added extra date behaves just like a normal one from a student's
 * point of view.
 */
export const ADMIN_CONSULTATION_LEAD_MS = 60 * 60_000;

/**
 * Europe/Moscow is UTC+3 year-round -- Russia abolished seasonal clock
 * changes in 2014, so unlike most "Europe/..." zones this offset never
 * needs DST-aware conversion. Cloudflare Cron Triggers only understand UTC,
 * so every place that needs "is it 09:30 Moscow time" works in UTC using
 * this fixed offset instead of a timezone database.
 */
export const MOSCOW_UTC_OFFSET_MINUTES = 3 * 60;
