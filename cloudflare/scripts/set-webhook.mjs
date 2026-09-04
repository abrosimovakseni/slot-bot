#!/usr/bin/env node
/**
 * One-time (or one-time-per-URL-change) helper: tells Telegram where to
 * deliver updates for this bot, and installs the shared secret Telegram
 * will echo back on every delivery so the Worker's fetch() handler can
 * verify a request genuinely came from Telegram (see src/index.ts).
 *
 * Usage:
 *   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://slot-hse-bot.<subdomain>.workers.dev \
 *     node scripts/set-webhook.mjs
 *
 * BOT_TOKEN and WEBHOOK_SECRET should be the exact same values already set
 * with `wrangler secret put` -- this script only calls Telegram's API, it
 * never touches Cloudflare.
 */
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WORKER_URL = process.env.WORKER_URL;

function fail(message) {
  console.error(`set-webhook: ${message}`);
  process.exit(1);
}

if (!BOT_TOKEN) fail("missing BOT_TOKEN env var");
if (!WEBHOOK_SECRET) fail("missing WEBHOOK_SECRET env var");
if (!WORKER_URL) fail("missing WORKER_URL env var (e.g. https://slot-hse-bot.<subdomain>.workers.dev)");

const url = `${WORKER_URL.replace(/\/$/, "")}/webhook`;

const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  }),
});

const data = await resp.json();
if (!data.ok) {
  fail(`Telegram rejected setWebhook: ${JSON.stringify(data)}`);
}

console.log(`Webhook registered: ${url}`);
console.log(JSON.stringify(data, null, 2));
