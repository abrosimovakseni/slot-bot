/**
 * Webhook delivery idempotency guard. Telegram retries a webhook call if it
 * doesn't receive a prompt 200 OK (slow cold start, transient network
 * blip, etc.), which would otherwise reprocess the same update -- a second
 * signup attempt, a second "Да" tap, and so on. Claiming the update_id
 * atomically before doing any work makes every handler idempotent for
 * free, the same way the Railway version claims `opened_notified_at` /
 * `finalized_at` before doing one-time work.
 */
import type { Env } from "../types";

/** Returns true if this is the first time we've seen this update_id. */
export async function claimUpdate(env: Env, updateId: number): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO processed_updates (update_id, processed_at) VALUES (?, ?) ON CONFLICT (update_id) DO NOTHING",
  )
    .bind(updateId, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
