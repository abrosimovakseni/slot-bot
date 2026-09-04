/**
 * Consultation lifecycle: creating/opening the weekly slots, finalizing
 * them the next day, and reconciling all of that against whatever's
 * actually in D1. D1 port of services/consultations.py -- see that file's
 * (and this project's own) extensive comments for the *why*; this is a
 * faithful translation of the same rules, including the same-day
 * "class already happened" bound fix.
 *
 * IDEMPOTENCY
 * --------------------------------------------------------------------------
 * Both "opening" (broadcast) and "finalizing" (status toggle) use an atomic
 * claim: `UPDATE ... SET <marker> = ? WHERE <marker> IS NULL`, checking
 * `meta.changes` to know whether *this* call is the one that gets to do the
 * one-time work. D1 serializes writes to a database at the storage layer,
 * so this is race-free without any extra locking, exactly like the
 * Postgres version's `UPDATE ... RETURNING` claim pattern.
 *
 * Finalization additionally needs the claim AND every status-toggle write
 * to commit together or not at all (otherwise a crash between them could
 * mark a consultation finalized without actually toggling anyone's
 * status). `env.DB.batch([...])` runs a list of statements as one
 * transaction, but batch statements don't see each other's *results* to
 * branch on -- so each toggle statement carries its own WHERE guard tying
 * it to the exact claim timestamp the first statement in the batch is
 * trying to set, making the whole batch conditionally atomic on that claim
 * succeeding.
 *
 * RESTART RECOVERY
 * --------------------------------------------------------------------------
 * `reconcile()` is the single entry point that makes the bot self-healing,
 * called by the cron triggers (see index.ts). No in-memory state is ever
 * relied on; the source of truth is always D1.
 */
import { toggleStatus } from "../queueLogic";
import { allWeekOccurrences, moscowDateKey } from "../timeUtils";
import type { ConsultationRow, Env, PriorityStatus } from "../types";

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------
export interface FinalizeResult {
  alreadyFinalized: boolean;
  toggledUserIds: number[];
}

export async function finalizeConsultation(env: Env, consultationId: number): Promise<FinalizeResult> {
  const nowIso = new Date().toISOString();

  const { results: activeSignups } = await env.DB.prepare(
    "SELECT id, user_id FROM signups WHERE consultation_id = ? AND active = 1",
  )
    .bind(consultationId)
    .all<{ id: number; user_id: number }>();

  if (activeSignups.length === 0) {
    const claim = await env.DB.prepare(
      "UPDATE consultations SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL",
    )
      .bind(nowIso, consultationId)
      .run();
    return { alreadyFinalized: (claim.meta.changes ?? 0) === 0, toggledUserIds: [] };
  }

  const userIds = [...new Set(activeSignups.map((s) => s.user_id))];
  const placeholders = userIds.map(() => "?").join(",");
  const { results: userRows } = await env.DB.prepare(
    `SELECT telegram_user_id, priority_status FROM users WHERE telegram_user_id IN (${placeholders})`,
  )
    .bind(...userIds)
    .all<{ telegram_user_id: number; priority_status: PriorityStatus }>();
  const statusByUser = new Map(userRows.map((u) => [u.telegram_user_id, u.priority_status]));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE consultations SET finalized_at = ? WHERE id = ? AND finalized_at IS NULL").bind(
      nowIso,
      consultationId,
    ),
  ];

  // Every remaining statement only takes effect if the claim above actually
  // set finalized_at to *this* nowIso -- i.e. we won the claim. If someone
  // else already finalized this consultation (finalized_at is some other,
  // earlier value), this subquery guard makes these no-ops.
  const guard = "(SELECT finalized_at FROM consultations WHERE id = ?) = ?";
  const toggledUserIds: number[] = [];
  for (const userId of userIds) {
    const current = statusByUser.get(userId);
    if (current === undefined) continue; // defensive; FK guarantees this shouldn't happen
    const next = toggleStatus(current);
    statements.push(
      env.DB.prepare(`UPDATE users SET priority_status = ? WHERE telegram_user_id = ? AND ${guard}`).bind(
        next,
        userId,
        consultationId,
        nowIso,
      ),
    );
    toggledUserIds.push(userId);
  }
  for (const s of activeSignups) {
    statements.push(
      env.DB.prepare(`UPDATE signups SET counted_for_status = 1 WHERE id = ? AND ${guard}`).bind(
        s.id,
        consultationId,
        nowIso,
      ),
    );
  }

  const results = await env.DB.batch(statements);
  const alreadyFinalized = (results[0]!.meta.changes ?? 0) === 0;
  return { alreadyFinalized, toggledUserIds: alreadyFinalized ? [] : toggledUserIds };
}

// ---------------------------------------------------------------------------
// Creation + opening
// ---------------------------------------------------------------------------
export interface EnsureResult {
  consultationId: number;
  created: boolean;
  justOpened: boolean;
}

export async function ensureCreatedAndOpened(
  env: Env,
  label: string,
  scheduledAt: Date,
  opensAt: Date,
): Promise<EnsureResult> {
  const scheduledIso = scheduledAt.toISOString();
  const opensIso = opensAt.toISOString();
  const nowIso = new Date().toISOString();

  const insert = await env.DB.prepare(
    `INSERT INTO consultations (label, scheduled_at, registration_opens_at, created_at)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM consultations WHERE scheduled_at = ?)`,
  )
    .bind(label, scheduledIso, opensIso, nowIso, scheduledIso)
    .run();

  let consultationId: number;
  const created = (insert.meta.changes ?? 0) === 1;
  if (created) {
    consultationId = insert.meta.last_row_id as number;
  } else {
    const row = await env.DB.prepare("SELECT id FROM consultations WHERE scheduled_at = ?")
      .bind(scheduledIso)
      .first<{ id: number }>();
    consultationId = row!.id;
  }

  const claim = await env.DB.prepare(
    "UPDATE consultations SET opened_notified_at = ? WHERE id = ? AND opened_notified_at IS NULL",
  )
    .bind(nowIso, consultationId)
    .run();
  const justOpened = (claim.meta.changes ?? 0) === 1;

  return { consultationId, created, justOpened };
}

// ---------------------------------------------------------------------------
// Reconciliation (restart recovery + safety-net polling)
// ---------------------------------------------------------------------------
export interface ReconcileReport {
  finalized: Array<FinalizeResult & { consultationId: number }>;
  opened: EnsureResult[];
}

export async function reconcile(env: Env, now: Date = new Date()): Promise<ReconcileReport> {
  const report: ReconcileReport = { finalized: [], opened: [] };
  const todayMsk = moscowDateKey(now);

  // 1. Finalize anything whose consultation date is strictly in the past.
  const { results: unfinalized } = await env.DB.prepare(
    "SELECT id, scheduled_at FROM consultations WHERE finalized_at IS NULL",
  ).all<{ id: number; scheduled_at: string }>();
  const dueIds = unfinalized.filter((c) => moscowDateKey(new Date(c.scheduled_at)) < todayMsk).map((c) => c.id);

  for (const consultationId of dueIds) {
    const fr = await finalizeConsultation(env, consultationId);
    if (!fr.alreadyFinalized) {
      report.finalized.push({ ...fr, consultationId });
    }
  }

  // 2. Create/open this week's occurrences that are due.
  //
  // Three bounds, all required for a slot that doesn't exist yet:
  //   * now >= opensAt                          -- the opening moment has passed.
  //   * moscowDateKey(now) <= moscowDateKey(scheduledAt) -- only catch up
  //     *within* the consultation's own day (reconciling for the first
  //     time on Friday must not retroactively create Wednesday's slot).
  //   * now < scheduledAt                       -- and, within that same
  //     day, not *after* the class time has itself already passed (e.g.
  //     the bot's very first-ever startup happening at 15:00 on a Friday
  //     must not open registration for the 10:30 class that already
  //     happened that same morning). This bound only blocks *creating* a
  //     brand-new row -- an already-existing row (created earlier that
  //     same day, then the Worker restarted or a cron tick was missed)
  //     still gets recognized and, if needed, finished opening.
  for (const { entry, scheduledAt, opensAt } of allWeekOccurrences(now)) {
    if (now < opensAt) continue;
    if (moscowDateKey(now) > moscowDateKey(scheduledAt)) continue;

    const scheduledIso = scheduledAt.toISOString();
    const existing = await env.DB.prepare("SELECT id FROM consultations WHERE scheduled_at = ?")
      .bind(scheduledIso)
      .first<{ id: number }>();
    if (existing === null && now >= scheduledAt) continue;

    const er = await ensureCreatedAndOpened(env, entry.name, scheduledAt, opensAt);
    if (er.created || er.justOpened) {
      report.opened.push(er);
    }
  }

  return report;
}

export async function getConsultation(env: Env, id: number): Promise<ConsultationRow | null> {
  const row = await env.DB.prepare("SELECT * FROM consultations WHERE id = ?").bind(id).first<ConsultationRow>();
  return row ?? null;
}
