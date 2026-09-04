/**
 * Signup, cancellation, and the read-only queue views -- D1 port of
 * services/queue.py.
 *
 * CONCURRENCY: the Railway version takes a `SELECT ... FOR UPDATE` row lock
 * on the consultation to serialize concurrent signup/cancel calls. D1 has
 * no such lock, but it doesn't need one here: D1 serializes all writes to
 * a given database at the storage layer (one logical writer), so a single
 * atomic statement is enough to get the same guarantee. Signup uses
 *   INSERT ... SELECT ... WHERE NOT EXISTS (...)
 * and cancellation uses
 *   UPDATE ... SET active = 0 WHERE id = ? AND active = 1
 * -- both are one round trip each, so two concurrent requests for the same
 * user can never both succeed, exactly mirroring the partial unique index
 * (`uq_signups_one_active_per_user_per_consultation`) that backstops this
 * at the schema level either way.
 */
import { PRIORITY_SLOTS } from "../config";
import { computePositions, type SignupLike } from "../queueLogic";
import type { ConsultationRow, Env, PriorityStatus, SignupRow } from "../types";
import { getUser } from "./users";

async function loadActiveSignups(env: Env, consultationId: number): Promise<SignupRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM signups WHERE consultation_id = ? AND active = 1 ORDER BY id",
  )
    .bind(consultationId)
    .all<SignupRow>();
  return results;
}

function toSignupLike(rows: SignupRow[]): SignupLike[] {
  return rows.map((r) => ({ id: r.id, statusAtSignup: r.status_at_signup }));
}

export async function getCurrentConsultation(env: Env): Promise<ConsultationRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM consultations WHERE finalized_at IS NULL ORDER BY scheduled_at DESC LIMIT 1",
  ).first<ConsultationRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------
export type SignupOutcome =
  | { kind: "signed_up"; position: number; statusAtSignup: PriorityStatus }
  | { kind: "already_signed_up"; position: number; statusAtSignup: PriorityStatus }
  | { kind: "registration_not_open" }
  | { kind: "consultation_not_open" }
  | { kind: "user_not_registered" };

export async function signupUser(env: Env, consultationId: number, telegramUserId: number): Promise<SignupOutcome> {
  const consultation = await env.DB.prepare("SELECT * FROM consultations WHERE id = ?")
    .bind(consultationId)
    .first<ConsultationRow>();
  if (consultation === null || consultation.finalized_at !== null) {
    return { kind: "consultation_not_open" };
  }
  if (new Date() < new Date(consultation.registration_opens_at)) {
    return { kind: "registration_not_open" };
  }

  const before = await loadActiveSignups(env, consultationId);
  const existing = before.find((s) => s.user_id === telegramUserId);
  if (existing !== undefined) {
    const positions = computePositions(toSignupLike(before));
    return {
      kind: "already_signed_up",
      position: positions.get(existing.id)!,
      statusAtSignup: existing.status_at_signup,
    };
  }

  const user = await getUser(env, telegramUserId);
  if (user === null) {
    return { kind: "user_not_registered" };
  }

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO signups (consultation_id, user_id, status_at_signup, created_at, active)
     SELECT ?, ?, ?, ?, 1
     WHERE NOT EXISTS (
       SELECT 1 FROM signups WHERE consultation_id = ? AND user_id = ? AND active = 1
     )`,
  )
    .bind(consultationId, telegramUserId, user.priority_status, now, consultationId, telegramUserId)
    .run();

  if ((insert.meta.changes ?? 0) === 0) {
    // Lost a race to a concurrent signup from the same user -- fall back to
    // "already signed up" against whatever actually landed.
    const after = await loadActiveSignups(env, consultationId);
    const mine = after.find((s) => s.user_id === telegramUserId);
    if (mine === undefined) {
      // Extremely unlikely (would mean it was cancelled in between); treat
      // as not-yet-signed-up rather than crashing.
      return { kind: "consultation_not_open" };
    }
    const positions = computePositions(toSignupLike(after));
    return { kind: "already_signed_up", position: positions.get(mine.id)!, statusAtSignup: mine.status_at_signup };
  }

  const newSignupId = insert.meta.last_row_id as number;
  // Re-read the active signups fresh rather than reusing the `before`
  // snapshot taken earlier in this call: D1 has no row lock serializing
  // concurrent signups the way the Postgres version's `SELECT ... FOR
  // UPDATE` does, so by the time our own insert has committed, any number
  // of *other* concurrent signups for this consultation may have committed
  // too. Computing the position from a stale `before` would report the
  // same wrong position (e.g. everyone gets "position 1") to every caller
  // in a concurrent batch -- this re-read is what makes TEST15 hold.
  const after = await loadActiveSignups(env, consultationId);
  const positions = computePositions(toSignupLike(after));
  return { kind: "signed_up", position: positions.get(newSignupId)!, statusAtSignup: user.priority_status };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
export interface CancelOutcome {
  hadActiveSignup: boolean;
  /** telegram_user_id -> new position, only for users whose position actually changed. */
  changedPositions: Map<number, number>;
}

export async function cancelSignup(env: Env, consultationId: number, telegramUserId: number): Promise<CancelOutcome> {
  const consultation = await env.DB.prepare("SELECT * FROM consultations WHERE id = ?")
    .bind(consultationId)
    .first<ConsultationRow>();
  if (consultation === null || consultation.finalized_at !== null) {
    return { hadActiveSignup: false, changedPositions: new Map() };
  }

  const before = await loadActiveSignups(env, consultationId);
  const target = before.find((s) => s.user_id === telegramUserId);
  if (target === undefined) {
    return { hadActiveSignup: false, changedPositions: new Map() };
  }

  const positionsBefore = computePositions(toSignupLike(before));
  const now = new Date().toISOString();
  const update = await env.DB.prepare("UPDATE signups SET active = 0, cancelled_at = ? WHERE id = ? AND active = 1")
    .bind(now, target.id)
    .run();
  if ((update.meta.changes ?? 0) === 0) {
    // Someone else (e.g. a retried webhook delivery) already cancelled it.
    return { hadActiveSignup: false, changedPositions: new Map() };
  }

  // Fresh read rather than `before.filter(...)`, for the same reason as
  // signupUser's post-insert re-read: D1 has no row lock serializing this
  // against concurrent signups/cancellations for the same consultation, so
  // the true current state may already differ from `before` by the time
  // our own update has committed.
  const after = await loadActiveSignups(env, consultationId);
  const positionsAfter = computePositions(toSignupLike(after));

  const changed = new Map<number, number>();
  for (const s of after) {
    const oldPos = positionsBefore.get(s.id);
    const newPos = positionsAfter.get(s.id);
    if (oldPos !== newPos && newPos !== undefined) {
      changed.set(s.user_id, newPos);
    }
  }
  return { hadActiveSignup: true, changedPositions: changed };
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------
export interface QueueEntry {
  position: number;
  userId: number;
  displayName: string;
  isPlaceholder: boolean;
}

export async function getQueueView(env: Env, consultationId: number): Promise<QueueEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.status_at_signup, u.display_name
     FROM signups s JOIN users u ON u.telegram_user_id = s.user_id
     WHERE s.consultation_id = ? AND s.active = 1
     ORDER BY s.id`,
  )
    .bind(consultationId)
    .all<{ id: number; user_id: number; status_at_signup: PriorityStatus; display_name: string }>();

  const names = new Map(results.map((r) => [r.id, r.display_name]));
  const userIds = new Map(results.map((r) => [r.id, r.user_id]));
  const signups: SignupLike[] = results.map((r) => ({ id: r.id, statusAtSignup: r.status_at_signup }));
  const positions = computePositions(signups);

  const filledReserved = results.filter((r) => (positions.get(r.id) ?? 999) <= PRIORITY_SLOTS).length;

  const entries: QueueEntry[] = [];
  for (let pos = 1; pos <= PRIORITY_SLOTS; pos++) {
    const sid = results.find((r) => positions.get(r.id) === pos)?.id;
    if (sid !== undefined) {
      entries.push({ position: pos, userId: userIds.get(sid)!, displayName: names.get(sid)!, isPlaceholder: false });
    } else if (pos <= filledReserved) {
      continue;
    } else {
      entries.push({ position: pos, userId: 0, displayName: "Свободно", isPlaceholder: true });
    }
  }

  const rest = results
    .filter((r) => (positions.get(r.id) ?? 0) > PRIORITY_SLOTS)
    .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  for (const r of rest) {
    entries.push({ position: positions.get(r.id)!, userId: r.user_id, displayName: r.display_name, isPlaceholder: false });
  }

  return entries;
}

export interface MyPositionResult {
  signedUp: boolean;
  position?: number;
  statusAtSignup?: PriorityStatus;
}

export async function getMyPosition(env: Env, consultationId: number, telegramUserId: number): Promise<MyPositionResult> {
  const signups = await loadActiveSignups(env, consultationId);
  const mine = signups.find((s) => s.user_id === telegramUserId);
  if (mine === undefined) {
    return { signedUp: false };
  }
  const positions = computePositions(toSignupLike(signups));
  return { signedUp: true, position: positions.get(mine.id), statusAtSignup: mine.status_at_signup };
}
