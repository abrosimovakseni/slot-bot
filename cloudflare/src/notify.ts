/**
 * Mass notification fan-out via Cloudflare Queues -- D1/Queues port of
 * bot/notifications.py.
 *
 * WHY QUEUES (not just a for-loop in the cron handler)
 * --------------------------------------------------------------------------
 * The Workers Free plan caps a single invocation at 50 subrequests. A
 * cron tick that tried to `fetch()` Telegram once per student directly
 * would silently start failing once a course passed ~50 people. Instead,
 * the cron handler enqueues one small message per recipient (cheap, no
 * subrequest involved) and a separate queue consumer invocation -- itself
 * bound by the *consumer's own* 50-subrequest budget, but only handling
 * one small batch (`max_batch_size` in wrangler.toml) per invocation --
 * does the actual sending. A slow or blocked recipient, or a transient
 * Telegram error, only affects their own message; Cloudflare Queues
 * retries failed messages independently and routes ones that exhaust
 * retries to a dead-letter queue instead of ever blocking anyone else's
 * delivery.
 *
 * IDEMPOTENCY
 * --------------------------------------------------------------------------
 * Queues are at-least-once delivery, so the same message can be redelivered
 * after a transient failure. `notifications_sent` records a message as
 * sent *only after* it actually goes out (or after a blocked-recipient
 * outcome, which will never succeed no matter how many times it's
 * retried) -- never before attempting the send -- so a genuine transient
 * failure is still retried, but a redelivered *already-sent* message is a
 * safe no-op.
 */
import { consultationCancelled, openingBroadcast, positionChanged } from "./bot/texts";
import { markBlocked } from "./db/users";
import { signupInlineKeyboard, TelegramClient } from "./telegram";
import type { ConsultationRow, Env, NotifyMessage } from "./types";

const CHUNK_SIZE = 100; // Cloudflare Queues sendBatch() cap per call.

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function enqueueOpeningBroadcast(env: Env, consultation: ConsultationRow): Promise<void> {
  const { results: users } = await env.DB.prepare("SELECT telegram_user_id FROM users WHERE blocked = 0").all<{
    telegram_user_id: number;
  }>();
  const classTimeStr = mskTimeString(new Date(consultation.scheduled_at));

  const messages: NotifyMessage[] = users.map((u) => ({
    kind: "opening",
    telegramUserId: u.telegram_user_id,
    consultationId: consultation.id,
    detail: classTimeStr,
  }));

  for (const batch of chunk(messages, CHUNK_SIZE)) {
    await env.NOTIFY_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }
}

/** Admin cancelled a not-yet-finalized consultation -- everyone who had an
 * active signup for it is told, once each (see notifications_sent). */
export async function enqueueConsultationCancelled(
  env: Env,
  consultationId: number,
  telegramUserIds: number[],
  detail: string,
): Promise<void> {
  const messages: NotifyMessage[] = telegramUserIds.map((telegramUserId) => ({
    kind: "consultation_cancelled",
    telegramUserId,
    consultationId,
    detail,
  }));
  for (const batch of chunk(messages, CHUNK_SIZE)) {
    await env.NOTIFY_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }
}

export async function enqueuePositionChanged(
  env: Env,
  consultationId: number,
  changedPositions: Map<number, number>,
): Promise<void> {
  const messages: NotifyMessage[] = [...changedPositions.entries()].map(([telegramUserId, position]) => ({
    kind: "position_changed",
    telegramUserId,
    consultationId,
    detail: String(position),
  }));
  for (const batch of chunk(messages, CHUNK_SIZE)) {
    await env.NOTIFY_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }
}

function mskTimeString(date: Date): string {
  const shifted = new Date(date.getTime() + 3 * 60 * 60_000);
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const m = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** The queue consumer: processes one batch of notification messages. */
export async function processNotifyBatch(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
  const telegram = new TelegramClient(env.BOT_TOKEN);

  for (const message of batch.messages) {
    try {
      await processOne(env, telegram, message.body);
      message.ack();
    } catch (err) {
      console.warn(`notify consumer: transient failure for message ${message.id}: ${String(err)}`);
      message.retry();
    }
  }
}

async function processOne(env: Env, telegram: TelegramClient, body: NotifyMessage): Promise<void> {
  const already = await env.DB.prepare(
    "SELECT 1 FROM notifications_sent WHERE telegram_user_id = ? AND consultation_id = ? AND kind = ? AND detail = ?",
  )
    .bind(body.telegramUserId, body.consultationId, body.kind, body.detail)
    .first();
  if (already !== null) {
    return; // already delivered (or permanently given up on) -- safe no-op
  }

  const text =
    body.kind === "opening"
      ? openingBroadcast(body.detail)
      : body.kind === "position_changed"
        ? positionChanged(Number(body.detail))
        : consultationCancelled(body.detail);
  const replyMarkup = body.kind === "opening" ? signupInlineKeyboard(body.consultationId) : undefined;

  const result = await telegram.sendMessage(body.telegramUserId, text, { replyMarkup });

  if (result.blocked) {
    await markBlocked(env, body.telegramUserId, true);
    await recordSent(env, body);
    return;
  }
  if (!result.ok) {
    // Transient failure -- do NOT record as sent, so Cloudflare's retry
    // (and eventually the dead-letter queue) can genuinely retry it.
    throw new Error(`send failed for user ${body.telegramUserId}`);
  }
  await recordSent(env, body);
}

async function recordSent(env: Env, body: NotifyMessage): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notifications_sent (telegram_user_id, consultation_id, kind, detail, sent_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(body.telegramUserId, body.consultationId, body.kind, body.detail, new Date().toISOString())
    .run();
}
