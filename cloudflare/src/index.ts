/**
 * Worker entry point: three triggers, matching the Railway version's three
 * responsibilities (long-polling loop -> webhook, run_daily/run_repeating
 * jobs -> cron triggers, direct broadcast loop -> queue consumer).
 *
 *   fetch()     Telegram webhook delivery (POST /webhook).
 *   scheduled() Cron Triggers -- runs the same idempotent reconcile() the
 *               Railway version's post_init/run_repeating job used, so
 *               restart/redeploy/missed-tick recovery works identically.
 *   queue()     Consumes NOTIFY_QUEUE messages -- the mass-notification
 *               fan-out (see notify.ts for why this is a queue and not a
 *               plain loop).
 */
import { routeUpdate } from "./bot/router";
import { claimUpdate } from "./db/idempotency";
import { enqueueOpeningBroadcast } from "./notify";
import { getConsultation, reconcile } from "./db/consultations";
import { processNotifyBatch } from "./notify";
import { TelegramClient } from "./telegram";
import type { Env, NotifyMessage } from "./types";
import type { TelegramUpdate } from "./telegram";

const WEBHOOK_PATH = "/webhook";

async function notifyAdmin(env: Env, message: string): Promise<void> {
  if (!env.ADMIN_ID) return;
  try {
    const telegram = new TelegramClient(env.BOT_TOKEN);
    await telegram.sendMessage(Number(env.ADMIN_ID), `⚠️ SLOT bot error:\n${message.slice(0, 3500)}`);
  } catch {
    // best-effort only -- never let admin notification itself throw
  }
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const isNew = await claimUpdate(env, update.update_id);
  if (!isNew) {
    // Telegram retried a delivery we already fully processed (or are
    // already processing) -- idempotent no-op.
    return new Response("ok", { status: 200 });
  }

  try {
    await routeUpdate(env, update);
  } catch (err) {
    console.error(`routeUpdate failed for update ${update.update_id}: ${String(err)}`);
    await notifyAdmin(env, `update ${update.update_id}: ${String(err)}`);
    // Still 200: the update is already claimed, so a Telegram retry would
    // just no-op rather than help; returning 5xx would only cause Telegram
    // to keep retrying a delivery we can't act on twice anyway.
  }
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("SLOT bot is running.", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    try {
      const report = await reconcile(env, now);
      for (const er of report.opened) {
        if (!er.justOpened) continue;
        const consultation = await getConsultation(env, er.consultationId);
        if (consultation !== null) {
          await enqueueOpeningBroadcast(env, consultation);
        }
      }
      console.log(
        `reconcile @ ${now.toISOString()}: finalized=${report.finalized.length} opened=${report.opened.length}`,
      );
    } catch (err) {
      console.error(`scheduled reconcile failed: ${String(err)}`);
      await notifyAdmin(env, `reconcile @ ${now.toISOString()}: ${String(err)}`);
    }
  },

  async queue(batch: MessageBatch<NotifyMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    await processNotifyBatch(batch, env);
  },
};
