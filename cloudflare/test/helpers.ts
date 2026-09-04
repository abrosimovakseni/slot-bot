import type { Env, PriorityStatus } from "../src/types";

let nextFakeUserId = 900_000_000;
// Storage persists across `it()` blocks within one test file (verified
// empirically -- vitest-pool-workers does not reset D1 between tests in the
// same file), so consultation timestamps need their own monotonic offset to
// guarantee `scheduled_at` never collides with an earlier test's row.
let nextConsultationOffsetMs = 0;
function reserveConsultationOffset(): number {
  nextConsultationOffsetMs += 1000;
  return nextConsultationOffsetMs;
}

/** Registers a fresh test user directly (bypassing the bot flow), returning their telegram_user_id. */
export async function makeUser(
  env: Env,
  opts?: { telegramUserId?: number; displayName?: string; priorityStatus?: PriorityStatus },
): Promise<number> {
  const telegramUserId = opts?.telegramUserId ?? nextFakeUserId++;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (telegram_user_id, display_name, username, registered_at, priority_status, blocked)
     VALUES (?, ?, NULL, ?, ?, 0)`,
  )
    .bind(telegramUserId, opts?.displayName ?? `Test User ${telegramUserId}`, now, opts?.priorityStatus ?? "PRIORITY")
    .run();
  return telegramUserId;
}

export async function getUserStatus(env: Env, telegramUserId: number): Promise<PriorityStatus> {
  const row = await env.DB.prepare("SELECT priority_status FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ priority_status: PriorityStatus }>();
  return row!.priority_status;
}

/** Creates a consultation whose registration is already open (opens_at in the past, class time in the future). */
export async function createOpenConsultation(env: Env, label = "Test"): Promise<number> {
  const now = Date.now() + reserveConsultationOffset();
  const opensAt = new Date(now - 60_000).toISOString();
  const scheduledAt = new Date(now + 3_600_000).toISOString();
  const createdAt = new Date(now).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO consultations (label, scheduled_at, registration_opens_at, created_at, opened_notified_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(label, scheduledAt, opensAt, createdAt, createdAt)
    .run();
  return result.meta.last_row_id as number;
}

/** Creates a consultation whose registration has not opened yet. */
export async function createUnopenedConsultation(env: Env, label = "Test"): Promise<number> {
  const now = Date.now() + reserveConsultationOffset();
  const opensAt = new Date(now + 3_600_000).toISOString();
  const scheduledAt = new Date(now + 7_200_000).toISOString();
  const createdAt = new Date(now).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO consultations (label, scheduled_at, registration_opens_at, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(label, scheduledAt, opensAt, createdAt)
    .run();
  return result.meta.last_row_id as number;
}
