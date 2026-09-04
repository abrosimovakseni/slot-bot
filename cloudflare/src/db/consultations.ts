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
import { enqueueOpeningBroadcast, enqueueQueueRefresh } from "../notify";
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
  // Set from a WEEKLY_SCHEDULE entry's own curator/room (config.ts) when
  // that occurrence overrides the usual ones (e.g. Saturday's Боремир
  // Иванович/324) -- omitted for an entry that doesn't, so it falls back
  // to DEFAULT_CURATOR/DEFAULT_ROOM at the database level (migrations/0003),
  // exactly as before this parameter existed.
  curator?: string,
  room?: string,
): Promise<EnsureResult> {
  const scheduledIso = scheduledAt.toISOString();
  const opensIso = opensAt.toISOString();
  const nowIso = new Date().toISOString();

  const insert =
    curator !== undefined && room !== undefined
      ? await env.DB.prepare(
          `INSERT INTO consultations (label, scheduled_at, registration_opens_at, created_at, curator, room)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM consultations WHERE scheduled_at = ?)`,
        )
          .bind(label, scheduledIso, opensIso, nowIso, curator, room, scheduledIso)
          .run()
      : await env.DB.prepare(
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

export interface CreateResult {
  consultationId: number;
  created: boolean;
}

/**
 * Admin one-off consultations (see bot/handlers/admin.ts): creates the row
 * now (same idempotent insert as ensureCreatedAndOpened above), but leaves
 * it unopened -- registration opens automatically later, exactly like the
 * regular weekly schedule, once `registration_opens_at` (normally one
 * hour before class -- config.ADMIN_CONSULTATION_LEAD_MS) actually
 * arrives. See openDueConsultations() below for the "open when due" half.
 *
 * `curator`/`room` default to config.DEFAULT_CURATOR/DEFAULT_ROOM at the
 * database level (migrations/0003), so omitting them here is exactly the
 * "как обычно" choice in the admin flow.
 */
export async function createConsultationIfAbsent(
  env: Env,
  label: string,
  scheduledAt: Date,
  opensAt: Date,
  curator?: string,
  room?: string,
): Promise<CreateResult> {
  const scheduledIso = scheduledAt.toISOString();
  const opensIso = opensAt.toISOString();
  const nowIso = new Date().toISOString();

  const insert =
    curator !== undefined && room !== undefined
      ? await env.DB.prepare(
          `INSERT INTO consultations (label, scheduled_at, registration_opens_at, created_at, curator, room)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM consultations WHERE scheduled_at = ?)`,
        )
          .bind(label, scheduledIso, opensIso, nowIso, curator, room, scheduledIso)
          .run()
      : await env.DB.prepare(
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
  return { consultationId, created };
}

export interface OpenedConsultation {
  consultationId: number;
}

/**
 * Opens every not-yet-finalized, not-yet-opened consultation whose
 * registration_opens_at has arrived -- the generic "claim + open" half of
 * ensureCreatedAndOpened, without the "create if missing" half, so it
 * applies uniformly to rows regardless of how they were created: the
 * regular weekly-schedule reconcile() path below, or an admin one-off
 * (createConsultationIfAbsent above). Each open is claimed atomically
 * (same UPDATE...WHERE opened_notified_at IS NULL pattern used everywhere
 * else in this file), so calling this repeatedly -- the once-a-minute
 * safety-net tick, or an immediate check right after an admin creates a
 * consultation whose opening time has already arrived -- never re-opens
 * or re-broadcasts the same consultation twice.
 */
export async function openDueConsultations(env: Env, now: Date = new Date()): Promise<OpenedConsultation[]> {
  const nowIso = now.toISOString();
  const { results: due } = await env.DB.prepare(
    "SELECT id FROM consultations WHERE opened_notified_at IS NULL AND finalized_at IS NULL AND registration_opens_at <= ?",
  )
    .bind(nowIso)
    .all<{ id: number }>();

  const opened: OpenedConsultation[] = [];
  for (const { id } of due) {
    const claim = await env.DB.prepare(
      "UPDATE consultations SET opened_notified_at = ? WHERE id = ? AND opened_notified_at IS NULL",
    )
      .bind(nowIso, id)
      .run();
    if ((claim.meta.changes ?? 0) === 1) {
      opened.push({ consultationId: id });
    }
  }
  return opened;
}

/**
 * Atomically opens ONE specific consultation, if it's actually due and not
 * already opened/finalized, and -- unlike openDueConsultations() above --
 * broadcasts the opening itself instead of leaving that to the caller.
 * This is the exact-time counterpart to that sweep: it's what
 * ConsultationOpener's alarm() (see ../consultationOpener.ts) calls at
 * precisely a consultation's registration_opens_at instant, so an admin
 * one-off consultation (bot/handlers/admin.ts) opens to the second instead
 * of waiting for the next once-a-minute safety-net tick. Each entry in the
 * regular weekly schedule doesn't need this: its own precise cron trigger
 * IS its opens_at moment, so it already opens exactly on time via
 * reconcile()'s phase 2.
 *
 * Uses the exact same atomic claim (`UPDATE ... WHERE opened_notified_at
 * IS NULL`) as everywhere else in this file, so this alarm firing at
 * (nearly) the same moment as the safety-net sweep can never double-open
 * or double-broadcast the same consultation -- whichever claims first
 * wins, the other affects zero rows and is a safe no-op. Likewise, if the
 * consultation was cancelled (deleted) before the alarm fires, the claim
 * affects zero rows and nothing is broadcast.
 */
export async function openOneConsultationNow(env: Env, consultationId: number, now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const claim = await env.DB.prepare(
    "UPDATE consultations SET opened_notified_at = ? WHERE id = ? AND opened_notified_at IS NULL AND finalized_at IS NULL AND registration_opens_at <= ?",
  )
    .bind(nowIso, consultationId, nowIso)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) return;

  const consultation = await getConsultation(env, consultationId);
  if (consultation !== null) {
    await enqueueOpeningBroadcast(env, consultation);
    // A new consultation just became "current" -- anyone with a pinned
    // queue message should see it reset to this (empty-so-far) queue
    // rather than keep showing the previous, now-irrelevant one.
    await enqueueQueueRefresh(env);
  }
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

    const er = await ensureCreatedAndOpened(env, entry.name, scheduledAt, opensAt, entry.curator, entry.room);
    if (er.created || er.justOpened) {
      report.opened.push(er);
    }
  }

  // 3. Open anything else that's due but wasn't touched above -- in
  // practice, admin one-off consultations (see
  // bot/handlers/admin.ts / createConsultationIfAbsent), which phase 2
  // above doesn't know about since they're not part of the fixed weekly
  // schedule. A weekly-schedule row phase 2 already opened this same call
  // is never re-reported here, since its opened_notified_at is no longer
  // NULL by the time this query runs.
  for (const { consultationId } of await openDueConsultations(env, now)) {
    report.opened.push({ consultationId, created: false, justOpened: true });
  }

  return report;
}

export async function getConsultation(env: Env, id: number): Promise<ConsultationRow | null> {
  const row = await env.DB.prepare("SELECT * FROM consultations WHERE id = ?").bind(id).first<ConsultationRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Admin: one-off consultations (see bot/handlers/admin.ts)
// ---------------------------------------------------------------------------
export interface UpcomingConsultation {
  id: number;
  label: string;
  scheduled_at: string;
}

/** Not-yet-finalized consultations still ahead of `now`, earliest first --
 * backs the admin "cancel a consultation" picker. */
export async function listUpcomingConsultations(env: Env, now: Date = new Date()): Promise<UpcomingConsultation[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, label, scheduled_at FROM consultations WHERE finalized_at IS NULL AND scheduled_at > ? ORDER BY scheduled_at ASC",
  )
    .bind(now.toISOString())
    .all<UpcomingConsultation>();
  return results;
}

export interface DeleteConsultationResult {
  existed: boolean;
  /** telegram_user_ids who had an active signup at the time of deletion --
   * the caller notifies them the consultation was cancelled. */
  affectedUserIds: number[];
}

/**
 * Admin-initiated hard delete of a not-yet-finalized consultation (e.g. a
 * mistakenly-added one-off date, or the curator cancelling in advance).
 * Signups are removed explicitly in the same atomic batch as the
 * consultation row itself, rather than relying on the schema's
 * `ON DELETE CASCADE` -- D1 does not guarantee `PRAGMA foreign_keys=ON` is
 * in effect on every pooled connection, so an explicit batch is the
 * reliable way to keep this atomic, consistent with finalizeConsultation()
 * above. Deleting an id that no longer exists is a safe no-op
 * (`existed: false`), so a retried admin action can never double-notify.
 */
export async function deleteConsultation(env: Env, consultationId: number): Promise<DeleteConsultationResult> {
  const { results: activeSignups } = await env.DB.prepare(
    "SELECT user_id FROM signups WHERE consultation_id = ? AND active = 1",
  )
    .bind(consultationId)
    .all<{ user_id: number }>();

  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM signups WHERE consultation_id = ?").bind(consultationId),
    env.DB.prepare("DELETE FROM consultations WHERE id = ?").bind(consultationId),
  ]);
  const existed = (results[1]!.meta.changes ?? 0) === 1;
  return { existed, affectedUserIds: existed ? activeSignups.map((s) => s.user_id) : [] };
}

/** telegram_user_ids with an active signup for a consultation -- who to
 * notify when its curator/room changes (see "✏️ Изменить кабинет/куратора"
 * in bot/handlers/admin.ts). */
export async function activeSignupUserIds(env: Env, consultationId: number): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT user_id FROM signups WHERE consultation_id = ? AND active = 1")
    .bind(consultationId)
    .all<{ user_id: number }>();
  return results.map((r) => r.user_id);
}

/**
 * Changes who's teaching a consultation and/or its room, in place -- the
 * consultation keeps its id and every existing signup, only these two
 * fields change. Used when the usual room turns out to be unavailable for
 * a given week; see activeSignupUserIds() above for who needs telling.
 */
export async function updateConsultationDetails(
  env: Env,
  consultationId: number,
  curator: string,
  room: string,
): Promise<void> {
  await env.DB.prepare("UPDATE consultations SET curator = ?, room = ? WHERE id = ?")
    .bind(curator, room, consultationId)
    .run();
}
