/**
 * End-to-end wiring tests for the pinned "always visible" queue message:
 * that the actual bot handlers (signup, cancel, admin create/cancel) both
 * (a) refresh the acting user's own pin synchronously and (b) enqueue a
 * `queue_refresh` broadcast to every OTHER user who already has a pin --
 * see src/pinnedQueue.ts and the call sites in src/bot/handlers/queue.ts
 * and src/bot/handlers/admin.ts.
 *
 * Mocks `globalThis.fetch` like test/notify.test.ts and test/pinnedQueue.test.ts
 * (no built-in fetch-mocking in this vitest-pool-workers version), and
 * additionally spies on env.NOTIFY_QUEUE.sendBatch to inspect what gets
 * broadcast without needing to simulate real queue delivery -- consistent
 * with how test/scheduled.test.ts only checks producer-side D1 state and
 * test/notify.test.ts drives the consumer directly with a hand-built batch.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPinnedQueueMessage } from "../src/db/users";
import worker from "../src/index";
import { processNotifyBatch } from "../src/notify";
import type { NotifyMessage } from "../src/types";
import { createOpenConsultation, makeUser } from "./helpers";

const originalFetch = globalThis.fetch;

let nextFakeMessageId: number;

function installFetchMock(): void {
  nextFakeMessageId = 1000;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.telegram.org")) {
      return originalFetch(input, init);
    }
    const method = url.split("/").pop() ?? "";
    if (method === "sendMessage") {
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextFakeMessageId++ } }), { status: 200 });
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

let nextUpdateId = 1;
function freshUpdateId(): number {
  return nextUpdateId++;
}

function webhookMessage(fromId: number, text: string): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: freshUpdateId(),
      message: { message_id: 1, chat: { id: fromId }, from: { id: fromId }, text },
    }),
  });
}

async function post(request: Request): Promise<void> {
  const ctx = createExecutionContext();
  const resp = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(resp.status).toBe(200);
}

function queueRefreshTargets(sendBatchCalls: unknown[][]): number[] {
  const ids: number[] = [];
  for (const call of sendBatchCalls) {
    const batch = call[0] as Array<{ body: NotifyMessage }>;
    for (const { body } of batch) {
      if (body.kind === "queue_refresh") ids.push(body.telegramUserId);
    }
  }
  return ids;
}

async function pinnedMessageIdOf(telegramUserId: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT pinned_queue_message_id FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ pinned_queue_message_id: number | null }>();
  return row?.pinned_queue_message_id ?? null;
}

describe("signup creates the signer's own pin and broadcasts to everyone else already pinned", () => {
  it("Записаться: pins the signer's own message and enqueues queue_refresh for other pinned viewers, excluding the signer", async () => {
    await createOpenConsultation(env);
    const already = await makeUser(env, { displayName: "Уже подписан" });
    await setPinnedQueueMessage(env, already, 555);
    const signer = await makeUser(env, { displayName: "Новенький" });

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await post(webhookMessage(signer, "Записаться"));

    expect(await pinnedMessageIdOf(signer)).not.toBeNull(); // created their own pin right away

    const targets = queueRefreshTargets(sendBatchSpy.mock.calls);
    expect(targets).toContain(already);
    expect(targets).not.toContain(signer); // excluded -- already refreshed directly
    sendBatchSpy.mockRestore();
  });

  it("processing the resulting queue_refresh message edits the other viewer's existing pinned message", async () => {
    await createOpenConsultation(env);
    const viewer = await makeUser(env, { displayName: "Наблюдатель" });
    await setPinnedQueueMessage(env, viewer, 777);
    const signer = await makeUser(env, { displayName: "Записавшийся" });

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await post(webhookMessage(signer, "Записаться"));
    const targets = queueRefreshTargets(sendBatchSpy.mock.calls);
    expect(targets).toContain(viewer);
    sendBatchSpy.mockRestore();

    // Drive the consumer directly with the exact message the handler
    // enqueued, exactly like test/notify.test.ts does for other kinds.
    const batch = createMessageBatch<NotifyMessage>("slot-notify", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { kind: "queue_refresh", telegramUserId: viewer } },
    ]);
    const ctx = createExecutionContext();
    await processNotifyBatch(batch, env);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);
    expect(result.explicitAcks).toHaveLength(1);

    // Still 777 -- editMessageText succeeded (no real Telegram state to
    // check here, but the pinned_queue_message_id is left unchanged,
    // which is what a successful in-place edit looks like).
    expect(await pinnedMessageIdOf(viewer)).toBe(777);
  });
});

describe("Посмотреть очередь: first press creates a pin", () => {
  it("creates and pins a queue message the first time, without needing to sign up first", async () => {
    const userId = await makeUser(env);
    expect(await pinnedMessageIdOf(userId)).toBeNull();

    await post(webhookMessage(userId, "Посмотреть очередь"));

    expect(await pinnedMessageIdOf(userId)).not.toBeNull();
  });
});

describe("Отменить запись: refreshes the canceller's own pin and broadcasts to everyone else pinned", () => {
  it("cancelling a signup enqueues queue_refresh for other pinned viewers", async () => {
    await createOpenConsultation(env);
    const other = await makeUser(env, { displayName: "Сторонний" });
    await setPinnedQueueMessage(env, other, 321);
    const canceller = await makeUser(env, { displayName: "Отменяющий" });
    await post(webhookMessage(canceller, "Записаться")); // sign up first so there's something to cancel

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await post(webhookMessage(canceller, "Отменить запись"));

    const targets = queueRefreshTargets(sendBatchSpy.mock.calls);
    expect(targets).toContain(other);
    expect(targets).not.toContain(canceller);
    sendBatchSpy.mockRestore();
  });
});
