/**
 * Conversation state for the registration / edit-name flows.
 *
 * A long-running PTB process could keep this in memory (ConversationHandler
 * state); a Worker is stateless between invocations, so the same "ask name
 * -> confirm name" steps have to persist their tiny bit of state in D1
 * between one webhook call and the next.
 */
import type { Env, UserStateRow } from "../types";

export async function getState(env: Env, telegramUserId: number): Promise<UserStateRow | null> {
  const row = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<UserStateRow>();
  return row ?? null;
}

export async function setState(
  env: Env,
  telegramUserId: number,
  flow: "register" | "edit",
  state: "ASK_NAME" | "CONFIRM_NAME",
  pendingName: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_state (telegram_user_id, flow, state, pending_name, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       flow = excluded.flow, state = excluded.state,
       pending_name = excluded.pending_name, updated_at = excluded.updated_at`,
  )
    .bind(telegramUserId, flow, state, pendingName, now)
    .run();
}

export async function clearState(env: Env, telegramUserId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM user_state WHERE telegram_user_id = ?").bind(telegramUserId).run();
}
