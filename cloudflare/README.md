# SLOT bot -- Cloudflare edition (free-tier, serverless)

This is a from-scratch port of the SLOT Telegram bot (curator-consultation
queue for HSE students) onto a stack that costs **$0/month**: Cloudflare
Workers + D1 + Queues + Cron Triggers, all on Cloudflare's free tier.

The Railway version (`../` -- python-telegram-bot + PostgreSQL, long
polling) keeps running untouched. This directory does not replace it until
it has been deployed and verified live; until then the two are independent
and the Railway bot is still what real students use.

All business logic -- registration, the priority/restricted queue algorithm,
the Wednesday/Friday 09:30 schedule, idempotent consultation lifecycle --
was ported rule-for-rule from the Python version. Nothing about *what* the
bot decides changed; only *how it runs* changed.

## Why this stack

| Railway version | Cloudflare version | Why |
|---|---|---|
| Always-on Python process, long polling | Worker, invoked per request/schedule | No server to keep alive == no monthly hosting bill |
| PostgreSQL | D1 (SQLite) | Free managed DB on Cloudflare, no separate service to pay for |
| `run_repeating`/`post_init` jobs in-process | Cron Triggers | Workers have no background timers between invocations |
| Direct loop over recipients | Queues (producer in the cron handler, consumer does the sending) | See "Why Queues" below |

## Architecture

```
Telegram --webhook--> Worker.fetch()  --> D1 (users, consultations, signups, ...)
Cloudflare Cron    --> Worker.scheduled() --> reconcile() --> D1
                                           \-> NOTIFY_QUEUE.sendBatch() (fan-out)
Cloudflare Queues  --> Worker.queue()  --> D1 (notifications_sent) + Telegram sendMessage
```

* **`fetch()`** -- the Telegram webhook endpoint (`POST /webhook`). Verifies
  the `X-Telegram-Bot-Api-Secret-Token` header, claims the update
  (`processed_updates`) so a Telegram retry is a no-op, then routes it.
* **`scheduled()`** -- three Cron Triggers (see below) all call the same
  `reconcile()`, which finalizes any past-due consultation and opens the
  next one that's due. This is also what makes the bot self-healing after a
  deploy or a missed tick: `reconcile()` never assumes anything about what
  already happened, it only looks at D1's current state.
* **`queue()`** -- consumes `NOTIFY_QUEUE`, actually calling Telegram's
  `sendMessage` and recording `notifications_sent` so a retried delivery
  never double-sends.

## Timezone handling: Europe/Moscow in a UTC-only Cron

Cloudflare Cron Triggers only understand UTC -- there is no "Europe/Moscow"
option. Russia abolished seasonal clock changes in 2014, so Europe/Moscow
has been a **fixed UTC+3 offset year-round** ever since; unlike almost any
other "Europe/..." zone, this means the conversion never needs a timezone
database or DST logic, just constant arithmetic (`src/timeUtils.ts`,
`MOSCOW_UTC_OFFSET_MINUTES` in `src/config.ts`). 09:30 Europe/Moscow is
always 06:30 UTC, so:

```toml
crons = ["30 6 * * 3", "30 6 * * 5", "*/15 * * * *"]
#         Wed 09:30 MSK  Fri 09:30 MSK  safety net, every 15 min, every day
```

The safety-net tick exists so a missed or delayed precise trigger (a
deploy in progress, a transient platform hiccup) still gets caught within
15 minutes, using the exact same idempotent `reconcile()` path -- it can
never duplicate or re-broadcast an already-opened slot.

## Why Queues (not a plain loop in the cron handler)

The Workers **Free** plan caps a single invocation at 50 subrequests. If
the cron handler tried to `fetch()` Telegram once per student directly, a
course with more than ~50 registered users would silently start failing
partway through the broadcast -- with no way to know which fraction of the
group actually got notified. Instead:

1. `scheduled()` enqueues one small message per recipient (`NOTIFY_QUEUE`)
   -- cheap, not a subrequest.
2. A separate consumer invocation of `queue()` -- bound by *its own*
   50-subrequest budget, but handling only one small batch
   (`max_batch_size = 10` in `wrangler.toml`) per invocation -- does the
   actual sending.
3. A slow, blocked, or erroring recipient only affects their own message
   (`message.retry()`); Cloudflare retries it independently
   (`max_retries = 5`) and routes anything that still fails to
   `slot-notify-dlq` (the dead-letter queue) rather than ever blocking
   anyone else's delivery.

This is verified correct for 50+ person groups by
`test/notify.test.ts`'s mass-broadcast and partial-failure-isolation tests.

## D1 concurrency: no row locks, atomic single statements instead

The Railway/Postgres version serializes concurrent signups with
`SELECT ... FOR UPDATE`. D1 has no equivalent row lock -- but it doesn't
need one, because **D1 serializes all writes to a given database at the
storage layer** (one logical writer). A single atomic SQL statement is
therefore race-free on its own:

* Signup: `INSERT ... SELECT ... WHERE NOT EXISTS (...)` -- two concurrent
  signup attempts from the same user can never both insert a row.
* Cancellation: `UPDATE signups SET active = 0 WHERE id = ? AND active = 1`
  -- a second concurrent cancel sees `changes = 0` and treats it as an
  already-cancelled no-op.
* Finalization: `env.DB.batch([...])` runs the claim
  (`UPDATE consultations SET finalized_at = ? WHERE finalized_at IS NULL`)
  and every status-toggle statement as one transaction, with each toggle
  statement's own `WHERE (SELECT finalized_at ...) = ?` guard tying it to
  *this* call's claim timestamp -- so if another concurrent call wins the
  claim first, every one of this call's toggle statements becomes a no-op
  instead of double-toggling anyone's status.
* Schema backstop: `uq_signups_one_active_per_user_per_consultation` (a
  partial unique index) makes a duplicate active signup impossible even if
  the application-level guard above were ever wrong.

The one place this needed real care: **positions must be computed from a
fresh read taken *after* your own write commits, never from a snapshot
taken before it.** Under concurrent signups, several other requests can
commit between your read and your write; a position computed from a stale
snapshot would report the same wrong position (e.g. "you're #1") to every
caller in a concurrent batch. `signupUser()` and `cancelSignup()` in
`src/db/queue.ts` both re-read `loadActiveSignups()` after their write for
exactly this reason -- `test/queue.test.ts`'s `TEST15` (8 concurrent
signups from different users) is what originally caught this as a real bug
during development, and now guards against it regressing.

## Database schema

`migrations/0001_init.sql` -- `users`, `consultations`, `signups` (plus
`user_state` for the multi-step name-entry conversation, `processed_updates`
for webhook idempotency, and `notifications_sent` for queue-send
idempotency -- three tables the Railway version didn't need, because a
long-lived Python process could keep that state in memory between calls;
a Worker cannot, so it lives in D1 instead).

## Tests

```
npm install
npm test          # full suite
npm run typecheck # tsc --noEmit
```

60 tests across 8 files, run against a real in-memory D1 + Workers runtime
(`@cloudflare/vitest-pool-workers`, not a mock): pure logic
(`timeUtils`, `queueLogic`), signup/cancel/queue-position behavior
including concurrency, consultation lifecycle and the Cron-driven
`reconcile()` (Wednesday, Friday, repeated/safety-net ticks, and a
reconcile()-throws-without-crashing-the-trigger case), the webhook
endpoint end-to-end (security, full registration flow, idempotent
redelivery), and the Queues consumer (mass broadcast, blocked-recipient
handling, partial-failure isolation, idempotent redelivery). All were
verified stable across repeated full-suite runs, not just a single pass.

## Secrets

`BOT_TOKEN` and `WEBHOOK_SECRET` are never committed and never appear in
`wrangler.toml` -- they're set as Cloudflare secrets (`wrangler secret put`),
which are encrypted at rest and only ever injected into `env` at runtime.
`WEBHOOK_SECRET` is a random string only this Worker and Telegram know;
`fetch()` rejects any webhook request whose
`X-Telegram-Bot-Api-Secret-Token` header doesn't match it (`src/index.ts`),
so nobody who merely guesses the `/webhook` URL can feed fake updates in.

`.dev.vars` (git-ignored) holds these two values for local `wrangler dev`
runs only -- it is never read in production; production reads the real
Cloudflare secrets.

## Deployment (for later -- not yet done)

Not run yet. In order, once this local build is fully signed off:

1. `wrangler login` (one-time Cloudflare account auth).
2. `wrangler d1 create slot_bot_db`, paste the returned `database_id` into
   `wrangler.toml`.
3. `npm run db:migrate:remote`.
4. `wrangler queues create slot-notify` and
   `wrangler queues create slot-notify-dlq`.
5. `wrangler secret put BOT_TOKEN` / `wrangler secret put WEBHOOK_SECRET`.
6. `npm run deploy`.
7. `WORKER_URL=... BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.mjs`
   to point Telegram at the deployed Worker.
8. Verify end-to-end with a real Telegram account, side-by-side with the
   still-running Railway bot, before ever touching the Railway deployment.

This list is for reference later -- it is **not** the next step right now.
