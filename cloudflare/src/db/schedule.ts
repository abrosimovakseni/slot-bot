/**
 * The recurring weekly consultation schedule -- moved out of static config
 * (src/config.ts used to hardcode this in a WEEKLY_SCHEDULE array) into D1,
 * so the bot's own admin can add, edit and remove weekly slots through
 * Telegram itself (see bot/handlers/admin.ts's "📅 Еженедельный график"
 * flow) without any code change or redeploy. This is what makes the bot
 * resellable as-is to a different group/curator: a new owner configures
 * their own schedule entirely inside the chat they already know how to
 * use, never touching code, Cloudflare, or anything technical.
 *
 * See migrations/0004_weekly_schedule.sql for the table (and its seed data
 * -- the same three entries the old static array had, so an existing
 * deployment's behavior is unchanged until its admin edits something).
 */
import type { ScheduleEntry } from "../config";
import type { Env } from "../types";

export interface WeeklyScheduleRow {
  id: number;
  name: string;
  weekday: number; // 0=Monday..6=Sunday
  class_hour: number;
  class_minute: number;
  opens_hour: number;
  opens_minute: number;
  curator: string | null;
  room: string | null;
  active: number; // 0 | 1
  created_at: string;
}

function toScheduleEntry(row: WeeklyScheduleRow): ScheduleEntry {
  return {
    name: row.name,
    weekday: row.weekday,
    classHour: row.class_hour,
    classMinute: row.class_minute,
    opensHour: row.opens_hour,
    opensMinute: row.opens_minute,
    curator: row.curator ?? undefined,
    room: row.room ?? undefined,
  };
}

/** Active entries only, in a stable display order -- what reconcile()
 * (db/consultations.ts) uses each tick to know which weekday/time slots
 * exist "this week". */
export async function listActiveScheduleEntries(env: Env): Promise<ScheduleEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM weekly_schedule WHERE active = 1 ORDER BY weekday, class_hour, class_minute",
  ).all<WeeklyScheduleRow>();
  return results.map(toScheduleEntry);
}

/** Every entry regardless of active/inactive -- backs the admin's
 * "📅 Еженедельный график" list, so the admin can see (and delete) a
 * paused entry too, not just active ones. */
export async function listAllScheduleEntries(env: Env): Promise<WeeklyScheduleRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM weekly_schedule ORDER BY weekday, class_hour, class_minute",
  ).all<WeeklyScheduleRow>();
  return results;
}

export async function getScheduleEntry(env: Env, id: number): Promise<WeeklyScheduleRow | null> {
  const row = await env.DB.prepare("SELECT * FROM weekly_schedule WHERE id = ?").bind(id).first<WeeklyScheduleRow>();
  return row ?? null;
}

export interface NewScheduleEntry {
  name: string;
  weekday: number;
  classHour: number;
  classMinute: number;
  opensHour: number;
  opensMinute: number;
  /** Omit for "как обычно" -- falls back to config.DEFAULT_CURATOR/DEFAULT_ROOM
   * at consultation-creation time, same as the old static entries that
   * didn't set these. */
  curator?: string;
  room?: string;
}

export async function addScheduleEntry(env: Env, entry: NewScheduleEntry): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO weekly_schedule
       (name, weekday, class_hour, class_minute, opens_hour, opens_minute, curator, room, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      entry.name,
      entry.weekday,
      entry.classHour,
      entry.classMinute,
      entry.opensHour,
      entry.opensMinute,
      entry.curator ?? null,
      entry.room ?? null,
      new Date().toISOString(),
    )
    .run();
  return result.meta.last_row_id as number;
}

/** Hard delete -- a weekly_schedule row has no dependents (each
 * consultation created from it copies curator/room/label at creation time
 * and stands on its own afterwards), so unlike consultations there's no
 * signups table to clean up alongside it. */
export async function deleteScheduleEntry(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM weekly_schedule WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) === 1;
}
