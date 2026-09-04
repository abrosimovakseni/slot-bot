/**
 * User registration and profile management -- D1 port of services/users.py.
 * Registering an already-known user is a no-op that leaves their profile
 * (priority status, history) untouched, exactly like the Railway version.
 */
import type { Env, UserRow } from "../types";

export async function getUser(env: Env, telegramUserId: number): Promise<UserRow | null> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<UserRow>();
  return row ?? null;
}

export interface RegisterResult {
  user: UserRow;
  alreadyExisted: boolean;
}

export async function registerUser(
  env: Env,
  telegramUserId: number,
  displayName: string,
  username: string | null,
): Promise<RegisterResult> {
  const now = new Date().toISOString();
  // Single atomic statement: insert only if the user doesn't exist yet.
  // D1 serializes writes to a database, so this can't race with itself --
  // no separate "check then insert" round trip needed.
  const insert = await env.DB.prepare(
    `INSERT INTO users (telegram_user_id, display_name, username, registered_at, priority_status, blocked)
     SELECT ?, ?, ?, ?, 'PRIORITY', 0
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE telegram_user_id = ?)`,
  )
    .bind(telegramUserId, displayName.slice(0, 255), username, now, telegramUserId)
    .run();

  const user = await getUser(env, telegramUserId);
  if (user === null) {
    // Should be unreachable -- the INSERT either created it or it already existed.
    throw new Error(`registerUser: user ${telegramUserId} missing after insert`);
  }
  return { user, alreadyExisted: (insert.meta.changes ?? 0) === 0 };
}

export async function updateDisplayName(env: Env, telegramUserId: number, newName: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE telegram_user_id = ?")
    .bind(newName.slice(0, 255), telegramUserId)
    .run();
}

export async function syncUsername(env: Env, telegramUserId: number, username: string | null): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET username = ? WHERE telegram_user_id = ? AND username IS NOT ?",
  )
    .bind(username, telegramUserId, username)
    .run();
}

export async function markBlocked(env: Env, telegramUserId: number, blocked: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET blocked = ? WHERE telegram_user_id = ?")
    .bind(blocked ? 1 : 0, telegramUserId)
    .run();
}

export async function allReachableUsers(env: Env): Promise<UserRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE blocked = 0").all<UserRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Pinned "always visible" queue-status message (see ../pinnedQueue.ts)
// ---------------------------------------------------------------------------
export async function setPinnedQueueMessage(
  env: Env,
  telegramUserId: number,
  messageId: number | null,
): Promise<void> {
  await env.DB.prepare("UPDATE users SET pinned_queue_message_id = ? WHERE telegram_user_id = ?")
    .bind(messageId, telegramUserId)
    .run();
}

/** Everyone with a live pinned queue message -- i.e. everyone who has ever
 * signed up or pressed "Посмотреть очередь" and can still be reached. This
 * is the broadcast list for enqueueQueueRefresh(): only people who've
 * opted in by actually using the queue feature get their pin kept fresh,
 * rather than every registered user being pinned unconditionally. */
export async function pinnedQueueViewerIds(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare(
    "SELECT telegram_user_id FROM users WHERE blocked = 0 AND pinned_queue_message_id IS NOT NULL",
  ).all<{ telegram_user_id: number }>();
  return results.map((r) => r.telegram_user_id);
}
