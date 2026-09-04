/**
 * One Durable Object instance per admin one-off consultation (looked up by
 * consultation id via `idFromName` -- see bot/handlers/admin.ts's
 * `scheduleOpenAlarm`), whose only job is to fire a precise
 * `storage.setAlarm()` at that consultation's exact `registration_opens_at`
 * instant.
 *
 * WHY THIS EXISTS
 * --------------------------------------------------------------------------
 * The regular weekly schedule (Wed/Fri/Sat -- see WEEKLY_SCHEDULE in
 * config.ts) opens exactly on time for free already: each entry has its own
 * dedicated cron trigger firing at its precise opens_at moment (see
 * wrangler.toml, reconcile()'s phase 2). An admin one-off consultation's
 * opens_at is an arbitrary instant (one hour before whatever class time the
 * curator typed), so nothing lines up with a fixed cron trigger for it --
 * before this file existed, it could only be caught by the once-a-minute
 * safety-net sweep (db/consultations.ts's openDueConsultations()), meaning
 * up to ~60s of slop after the promised time. This closes that gap:
 * `alarm()` fires within a few seconds of the exact instant requested.
 *
 * The safety-net sweep is NOT removed -- it stays as the backup for the
 * (rare) case this alarm doesn't fire, e.g. a transient error scheduling
 * it. Both paths call the same atomic claim
 * (db/consultations.ts's openOneConsultationNow()), so whichever gets
 * there first wins and the other is a safe no-op -- see that function's
 * doc comment.
 *
 * FREE TIER
 * --------------------------------------------------------------------------
 * SQLite-backed Durable Objects (this class's storage backend -- see the
 * `new_sqlite_classes` migration in wrangler.toml) are included in the
 * Workers Free plan, same as everything else in this project.
 */
import { DurableObject } from "cloudflare:workers";
import { openOneConsultationNow } from "./db/consultations";
import type { Env } from "./types";

export class ConsultationOpener extends DurableObject<Env> {
  /** Remembers which consultation this instance is for and schedules the
   * alarm for `opensAtMs` (epoch milliseconds). Safe to call again for the
   * same instance if the opening time is ever recomputed --
   * `setAlarm()` simply replaces whatever alarm was already set. */
  async scheduleOpen(consultationId: number, opensAtMs: number): Promise<void> {
    await this.ctx.storage.put("consultationId", consultationId);
    await this.ctx.storage.setAlarm(opensAtMs);
  }

  /** Called when the consultation is cancelled before its opening time
   * arrives, so this instance doesn't wake up for nothing. Purely tidiness
   * -- openOneConsultationNow() is already a safe no-op once the
   * consultation row is gone, so skipping this call would never cause an
   * incorrect broadcast, just one wasted invocation. */
  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const consultationId = await this.ctx.storage.get<number>("consultationId");
    if (consultationId === undefined) return;
    await openOneConsultationNow(this.env, consultationId);
  }
}

/** One consultation always maps to the same Durable Object instance --
 * `idFromName` is deterministic, so looking this up again later (e.g. to
 * cancel) always finds the same instance without having to store its id
 * anywhere. Both helpers below are thin wrappers so call sites
 * (bot/handlers/admin.ts) don't need to know about idFromName/get. */
function stubFor(env: Env, consultationId: number) {
  const id = env.CONSULTATION_OPENER.idFromName(String(consultationId));
  return env.CONSULTATION_OPENER.get(id);
}

/** Schedules `consultationId`'s exact-time opening alarm for `opensAt`. */
export async function scheduleOpenAlarm(env: Env, consultationId: number, opensAt: Date): Promise<void> {
  await stubFor(env, consultationId).scheduleOpen(consultationId, opensAt.getTime());
}

/** Cancels a previously scheduled alarm -- see ConsultationOpener.cancel()'s
 * doc comment for why this is tidiness rather than a correctness need. */
export async function cancelOpenAlarm(env: Env, consultationId: number): Promise<void> {
  await stubFor(env, consultationId).cancel();
}
