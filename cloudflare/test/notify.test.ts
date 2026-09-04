/**
 * Queue-consumer tests: `processNotifyBatch` (the `queue()` handler's body).
 *
 * These mock `globalThis.fetch` rather than hitting api.telegram.org, so
 * send outcomes (success / blocked recipient / transient failure) are
 * deterministic and instant. `@cloudflare/vitest-pool-workers` doesn't ship
 * a built-in fetch-mocking facility for this version, so this is a plain
 * reassignment of the global -- safe here because `TelegramClient` always
 * calls the bare `fetch()` global (see src/telegram.ts) and every test
 * restores the original in `afterEach`.
 *
 * NOTE on the dead-letter queue: `max_retries` / DLQ routing after
 * exhausting retries is Cloudflare Queues infrastructure behaviour
 * (configured in wrangler.toml's `[[queues.consumers]]`), not application
 * code -- there is nothing in this repo left to unit-test for it beyond
 * "a transient failure calls `message.retry()` and never marks the message
 * sent", which the partial-failure test below covers. Exhausting retries
 * and landing in `slot-notify-dlq` is exercised by Cloudflare's own queue
 * broker in production, per the `dead_letter_queue` binding.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processNotifyBatch } from "../src/notify";
import type { NotifyMessage } from "../src/types";
import { createOpenConsultation, makeUser } from "./helpers";

type FetchOutcome = "ok" | "blocked" | "fail";

const originalFetch = globalThis.fetch;

/** chatId -> how the mock Telegram API should respond to a sendMessage for them. */
let outcomeByChatId: Map<number, FetchOutcome>;

function installFetchMock(): void {
  outcomeByChatId = new Map();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.telegram.org")) {
      return originalFetch(input, init);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number };
    const outcome = outcomeByChatId.get(body.chat_id ?? -1) ?? "ok";
    if (outcome === "blocked") {
      return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" }), { status: 403 });
    }
    if (outcome === "fail") {
      return new Response(JSON.stringify({ ok: false, error_code: 500, description: "Internal Error" }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeBatch(messages: NotifyMessage[]) {
  return createMessageBatch<NotifyMessage>(
    "slot-notify",
    messages.map((body, i) => ({ id: `msg-${Date.now()}-${i}-${Math.random()}`, timestamp: new Date(), attempts: 1, body })),
  );
}

async function sentCount(telegramUserId: number, consultationId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM notifications_sent WHERE telegram_user_id = ? AND consultation_id = ?",
  )
    .bind(telegramUserId, consultationId)
    .first<{ c: number }>();
  return row!.c;
}

describe("processNotifyBatch: mass broadcast", () => {
  it("sends the opening broadcast to every recipient in a batch and acks each one", async () => {
    const consultationId = await createOpenConsultation(env);
    const userIds = await Promise.all(Array.from({ length: 12 }, () => makeUser(env)));
    for (const uid of userIds) outcomeByChatId.set(uid, "ok");

    const messages: NotifyMessage[] = userIds.map((uid) => ({
      kind: "opening",
      telegramUserId: uid,
      consultationId,
      detail: "10:30",
    }));
    const batch = makeBatch(messages);
    const ctx = createExecutionContext();
    await processNotifyBatch(batch, env);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.explicitAcks).toHaveLength(userIds.length);
    expect(result.retryMessages).toHaveLength(0);

    for (const uid of userIds) {
      expect(await sentCount(uid, consultationId)).toBe(1);
    }
  });

  it("a blocked recipient is marked blocked, recorded as sent, and never retried", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    outcomeByChatId.set(userId, "blocked");

    const batch = makeBatch([{ kind: "opening", telegramUserId: userId, consultationId, detail: "10:30" }]);
    const ctx = createExecutionContext();
    await processNotifyBatch(batch, env);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
    expect(await sentCount(userId, consultationId)).toBe(1);

    const row = await env.DB.prepare("SELECT blocked FROM users WHERE telegram_user_id = ?")
      .bind(userId)
      .first<{ blocked: number }>();
    expect(row!.blocked).toBe(1);
  });

  it("partial failure isolation: one recipient's transient failure never blocks the others in the same batch", async () => {
    const consultationId = await createOpenConsultation(env);
    const [good1, bad, good2] = await Promise.all([makeUser(env), makeUser(env), makeUser(env)]);
    outcomeByChatId.set(good1!, "ok");
    outcomeByChatId.set(bad!, "fail");
    outcomeByChatId.set(good2!, "ok");

    const messages: NotifyMessage[] = [good1!, bad!, good2!].map((uid) => ({
      kind: "opening",
      telegramUserId: uid,
      consultationId,
      detail: "10:30",
    }));
    const batch = makeBatch(messages);
    const ctx = createExecutionContext();
    await processNotifyBatch(batch, env);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toHaveLength(1);

    expect(await sentCount(good1!, consultationId)).toBe(1);
    expect(await sentCount(good2!, consultationId)).toBe(1);
    expect(await sentCount(bad!, consultationId)).toBe(0); // never recorded -- must still be retried
  });
});

describe("processNotifyBatch: idempotent redelivery", () => {
  it("a message already recorded as sent is a safe no-op on redelivery -- no duplicate send, no duplicate row", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    outcomeByChatId.set(userId, "ok");

    const message: NotifyMessage = { kind: "opening", telegramUserId: userId, consultationId, detail: "10:30" };

    let ctx = createExecutionContext();
    await processNotifyBatch(makeBatch([message]), env);
    await waitOnExecutionContext(ctx);
    expect(await sentCount(userId, consultationId)).toBe(1);

    // Cloudflare Queues is at-least-once delivery -- the exact same message
    // (same kind/user/consultation/detail) can be redelivered after the
    // first delivery's ack was lost in transit.
    outcomeByChatId.set(userId, "fail"); // if this redelivery actually tried to send, it would now fail
    ctx = createExecutionContext();
    const batch = makeBatch([message]);
    await processNotifyBatch(batch, env);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);

    expect(result.explicitAcks).toHaveLength(1); // recognized as already-sent, acked without resending
    expect(await sentCount(userId, consultationId)).toBe(1); // still exactly one row
  });

  it("position_changed notifications are keyed independently per new position -- a later change is a distinct send", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env);
    outcomeByChatId.set(userId, "ok");

    let ctx = createExecutionContext();
    await processNotifyBatch(
      makeBatch([{ kind: "position_changed", telegramUserId: userId, consultationId, detail: "3" }]),
      env,
    );
    await waitOnExecutionContext(ctx);

    ctx = createExecutionContext();
    await processNotifyBatch(
      makeBatch([{ kind: "position_changed", telegramUserId: userId, consultationId, detail: "2" }]),
      env,
    );
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM notifications_sent WHERE telegram_user_id = ? AND consultation_id = ? AND kind = 'position_changed'",
    )
      .bind(userId, consultationId)
      .first<{ c: number }>();
    expect(row!.c).toBe(2); // two distinct positions -- both real, both delivered
  });
});
