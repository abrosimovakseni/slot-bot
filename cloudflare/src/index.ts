/**
 * Worker entry point: three triggers, matching the Railway version's three
 * responsibilities (long-polling loop -> webhook, run_daily/run_repeating
 * jobs -> cron triggers, direct broadcast loop -> queue consumer).
 *
 *   fetch()     Telegram webhook delivery (POST /webhook).
 *   scheduled() Cron Triggers -- runs the same idempotent reconcile() the
 *               Railway version's post_init/run_repeating job used, so
 *               restart/redeploy/missed-tick recovery works identically.
 *               One specific trigger (WEBHOOK_REASSERT_CRON, see
 *               wrangler.toml) does something different -- see
 *               reassertWebhook() below -- everything else runs reconcile().
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

// Re-exported so wrangler can find the class named in wrangler.toml's
// `durable_objects` binding -- see consultationOpener.ts's doc comment.
export { ConsultationOpener } from "./consultationOpener";

const WEBHOOK_PATH = "/webhook";

// Must match wrangler.toml's `[triggers]` entry exactly -- see that file's
// comment for the full why. Kept as its own constant (rather than inlined
// in scheduled() below) so the two are easy to keep in sync.
const WEBHOOK_REASSERT_CRON = "0 2 * * *";

async function notifyAdmin(env: Env, message: string): Promise<void> {
  if (!env.ADMIN_ID) return;
  try {
    const telegram = new TelegramClient(env.BOT_TOKEN);
    await telegram.sendMessage(Number(env.ADMIN_ID), `⚠️ SLOT bot error:\n${message.slice(0, 3500)}`);
  } catch {
    // best-effort only -- never let admin notification itself throw
  }
}

/**
 * Re-registers the Telegram webhook with the CURRENT url + WEBHOOK_SECRET,
 * whether or not anything looks wrong -- see wrangler.toml's
 * WEBHOOK_REASSERT_CRON comment for the full why (in short: this is the
 * only way to guarantee Telegram's stored secret always matches ours,
 * since Telegram never exposes what it currently has on file to compare
 * against, only whether the *last actual delivery* succeeded).
 *
 * Deliberately entirely separate from reconcile() -- doesn't touch D1, the
 * notify queue, or any student-facing flow, only Telegram's own webhook
 * config, so it can never delay or interfere with anyone signing up or
 * being notified.
 */
async function reassertWebhook(env: Env): Promise<void> {
  const telegram = new TelegramClient(env.BOT_TOKEN);
  const result = await telegram.setWebhook(`${env.WORKER_URL}${WEBHOOK_PATH}`, env.WEBHOOK_SECRET);
  if (!result.ok) {
    await notifyAdmin(env, "daily webhook re-assert failed -- setWebhook did not return ok");
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
    if (controller.cron === WEBHOOK_REASSERT_CRON) {
      await reassertWebhook(env);
      return;
    }
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
