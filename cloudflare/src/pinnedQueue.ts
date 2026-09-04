/**
 * Keeps one "always visible" queue-status message pinned in each student's
 * DM with the bot, so they can see who's signed up and at what position
 * without pressing "Посмотреть очередь" again every time (per Ksenia's
 * request: the queue should just stay visible and update itself).
 *
 * DESIGN
 * --------------------------------------------------------------------------
 * One message per user (users.pinned_queue_message_id), created and pinned
 * the first time it's needed (first signup, or first "Посмотреть очередь"
 * press -- see bot/handlers/queue.ts), edited in place afterwards. The text
 * is always the FULL current queue for whatever consultation
 * getCurrentConsultation() considers current, with the viewer's own row
 * marked -- not a personal "your position" number, so everyone pinned sees
 * the same shared picture of who's where.
 *
 * IDEMPOTENCY -- deliberately NOT like notify.ts
 * --------------------------------------------------------------------------
 * notify.ts's notifications_sent table exists to guard against *duplicate
 * sends* of a one-off message. A pinned-message refresh isn't a "send" at
 * all -- it's "make the pinned message match current reality", which is
 * naturally idempotent: editing a message to the same (or newer) text
 * twice in a row has no observable duplicate effect. So refreshes never
 * touch notifications_sent, and a redelivered "queue_refresh" queue
 * message (Cloudflare Queues is at-least-once) is simply a safe no-op --
 * see notify.ts's processOne().
 *
 * RECOVERY
 * --------------------------------------------------------------------------
 * If the user deletes the pinned message (or unpins-and-deletes it),
 * Telegram's editMessageText call fails with "message to edit not found"
 * (surfaced as SendResult.notFound -- see telegram.ts). That's treated as
 * "no pin exists" and a fresh message is sent and pinned, exactly like the
 * very first time.
 */
import { getCurrentConsultation, getQueueView, type QueueEntry } from "./db/queue";
import { getUser, setPinnedQueueMessage } from "./db/users";
import { NO_CURRENT_CONSULTATION, QUEUE_EMPTY, QUEUE_HEADER } from "./bot/texts";
import type { TelegramClient } from "./telegram";
import type { Env } from "./types";

function formatQueueSnapshot(entries: QueueEntry[], viewerUserId: number): string {
  if (entries.length === 0) {
    return `${QUEUE_HEADER}\n${QUEUE_EMPTY}`;
  }
  const lines = entries.map((e) => {
    const mine = !e.isPlaceholder && e.userId === viewerUserId;
    return `${e.position}. ${e.displayName}${mine ? " ← вы" : ""}`;
  });
  return [QUEUE_HEADER, ...lines].join("\n");
}

/** The text the pinned message should currently show for `viewerUserId`. */
export async function currentQueueSnapshotText(env: Env, viewerUserId: number): Promise<string> {
  const consultation = await getCurrentConsultation(env);
  if (consultation === null) {
    return `${QUEUE_HEADER}\n${NO_CURRENT_CONSULTATION}`;
  }
  const entries = await getQueueView(env, consultation.id);
  return formatQueueSnapshot(entries, viewerUserId);
}

/**
 * Edits `pinnedMessageId` to the current snapshot, or -- if there isn't one
 * yet, or it's gone -- sends a fresh message and pins it. Never throws:
 * a blocked recipient or a genuine transient failure is simply left for
 * the next queue-changing event to retry (this mirrors notify.ts's
 * "don't crash the batch over one recipient" philosophy, but without the
 * queue-retry machinery, since staleness here is self-healing).
 */
export async function refreshPinnedQueueMessage(
  env: Env,
  telegram: TelegramClient,
  telegramUserId: number,
  pinnedMessageId: number | null,
): Promise<void> {
  const text = await currentQueueSnapshotText(env, telegramUserId);

  if (pinnedMessageId !== null) {
    const edit = await telegram.editMessageText(telegramUserId, pinnedMessageId, text);
    if (edit.ok || edit.blocked || !edit.notFound) {
      // Either it worked, or the recipient is unreachable, or this was some
      // other (presumably transient) failure -- in every one of those
      // cases there is nothing more useful to do right now.
      return;
    }
    // edit.notFound: the pinned message is gone -- fall through and
    // recreate it, exactly like the first-ever refresh for this user.
  }

  const sent = await telegram.sendMessage(telegramUserId, text);
  if (sent.ok && sent.messageId !== undefined) {
    await telegram.pinChatMessage(telegramUserId, sent.messageId);
    await setPinnedQueueMessage(env, telegramUserId, sent.messageId);
  }
}

/** Convenience wrapper: looks up the user's current pinned_queue_message_id
 * fresh from D1 (never trusting a value the caller might be holding stale)
 * and refreshes it. Silently does nothing for an unknown/blocked user. */
export async function refreshPinnedQueueMessageForUser(
  env: Env,
  telegram: TelegramClient,
  telegramUserId: number,
): Promise<void> {
  const user = await getUser(env, telegramUserId);
  if (user === null || user.blocked === 1) return;
  await refreshPinnedQueueMessage(env, telegram, telegramUserId, user.pinned_queue_message_id);
}
