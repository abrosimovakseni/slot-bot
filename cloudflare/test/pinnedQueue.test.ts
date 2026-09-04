/**
 * Unit tests for src/pinnedQueue.ts: the text it computes, and the
 * create-vs-edit-vs-recreate decision in refreshPinnedQueueMessage(). Mocks
 * `globalThis.fetch` the same way test/notify.test.ts does -- there's no
 * built-in fetch-mocking in this vitest-pool-workers version (see that
 * file's header comment) -- but here the mock also needs to hand back a
 * `message_id` for sendMessage, and can be told to make a specific
 * editMessageText call fail as "not found", so it's a bit richer.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signupUser } from "../src/db/queue";
import { pinnedQueueViewerIds, setPinnedQueueMessage } from "../src/db/users";
import { currentQueueSnapshotText, refreshPinnedQueueMessage, refreshPinnedQueueMessageForUser } from "../src/pinnedQueue";
import { TelegramClient } from "../src/telegram";
import { createOpenConsultation, makeUser } from "./helpers";

const originalFetch = globalThis.fetch;

type Call = { method: string; body: Record<string, unknown> };

let calls: Call[];
/** editMessageText calls for this message_id will be answered as "not found". */
let notFoundMessageId: number | null;
let nextFakeMessageId: number;

function installFetchMock(): void {
  calls = [];
  notFoundMessageId = null;
  nextFakeMessageId = 1;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.telegram.org")) {
      return originalFetch(input, init);
    }
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });

    if (method === "editMessageText" && body.message_id === notFoundMessageId) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }),
        { status: 200 },
      );
    }
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

describe("currentQueueSnapshotText", () => {
  it("shows 'no current consultation' when nothing is open", async () => {
    const userId = await makeUser(env);
    const text = await currentQueueSnapshotText(env, userId);
    expect(text).toContain("Сейчас нет открытой записи");
  });

  it("shows the reserved slots as free when a consultation is open but nobody's signed up yet -- same as the on-demand 'Посмотреть очередь' view", async () => {
    await createOpenConsultation(env, "Пустая");
    const userId = await makeUser(env);
    const text = await currentQueueSnapshotText(env, userId);
    expect(text).toContain("1. Свободно");
  });

  it("the header names the curator, room and class time so the queue is identifiable on its own", async () => {
    await createOpenConsultation(env, "С данными");
    const userId = await makeUser(env);
    const text = await currentQueueSnapshotText(env, userId);
    // createOpenConsultation() doesn't pass curator/room explicitly, so the
    // DB-level defaults from migrations/0003 apply (config.DEFAULT_CURATOR /
    // DEFAULT_ROOM).
    expect(text).toContain("Куратор: Любовь Котлярова");
    expect(text).toContain("Кабинет: 332");
    expect(text).toMatch(/Очередь на консультацию в \d{2}:\d{2}/);
  });

  it("lists everyone with positions, marking the viewer's own row", async () => {
    const consultationId = await createOpenConsultation(env, "С людьми");
    const [alice, bob] = await Promise.all([
      makeUser(env, { displayName: "Алиса" }),
      makeUser(env, { displayName: "Боб" }),
    ]);
    await signupUser(env, consultationId, alice!);
    await signupUser(env, consultationId, bob!);

    const forAlice = await currentQueueSnapshotText(env, alice!);
    expect(forAlice).toContain("1. Алиса ← вы");
    expect(forAlice).toContain("2. Боб");
    expect(forAlice).not.toContain("Боб ← вы");

    const forBob = await currentQueueSnapshotText(env, bob!);
    expect(forBob).toContain("1. Алиса");
    expect(forBob).not.toContain("Алиса ← вы");
    expect(forBob).toContain("2. Боб ← вы");
  });

  it("does not mark a placeholder 'Свободно' slot as the viewer's own row", async () => {
    const consultationId = await createOpenConsultation(env, "С местами");
    const userId = await makeUser(env, { displayName: "Единственный" });
    await signupUser(env, consultationId, userId);
    const text = await currentQueueSnapshotText(env, userId);
    expect(text).toContain("1. Единственный ← вы");
    // Placeholder rows carry userId 0 -- must never accidentally match a
    // real viewerUserId (0 is never a valid telegram_user_id, but this
    // guards the intent explicitly).
    expect(text).not.toContain("Свободно ← вы");
  });
});

describe("refreshPinnedQueueMessage: create / edit / recreate", () => {
  it("with no existing pin, sends a fresh message and pins it, saving the new message_id", async () => {
    const userId = await makeUser(env);
    const telegram = new TelegramClient(env.BOT_TOKEN);

    await refreshPinnedQueueMessage(env, telegram, userId, null);

    const sendCalls = calls.filter((c) => c.method === "sendMessage");
    const pinCalls = calls.filter((c) => c.method === "pinChatMessage");
    expect(sendCalls).toHaveLength(1);
    expect(pinCalls).toHaveLength(1);

    const row = await env.DB.prepare("SELECT pinned_queue_message_id FROM users WHERE telegram_user_id = ?")
      .bind(userId)
      .first<{ pinned_queue_message_id: number | null }>();
    expect(row!.pinned_queue_message_id).not.toBeNull();
    expect(pinCalls[0]!.body.message_id).toBe(row!.pinned_queue_message_id);
  });

  it("with an existing pin, edits it in place instead of sending a new message", async () => {
    const userId = await makeUser(env);
    await setPinnedQueueMessage(env, userId, 42);
    const telegram = new TelegramClient(env.BOT_TOKEN);

    await refreshPinnedQueueMessage(env, telegram, userId, 42);

    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    const editCalls = calls.filter((c) => c.method === "editMessageText");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]!.body.message_id).toBe(42);

    const row = await env.DB.prepare("SELECT pinned_queue_message_id FROM users WHERE telegram_user_id = ?")
      .bind(userId)
      .first<{ pinned_queue_message_id: number | null }>();
    expect(row!.pinned_queue_message_id).toBe(42); // unchanged -- edit succeeded, no need to recreate
  });

  it("if the pinned message was deleted (editMessageText 'not found'), recreates and re-pins a new one", async () => {
    const userId = await makeUser(env);
    await setPinnedQueueMessage(env, userId, 99);
    notFoundMessageId = 99;
    const telegram = new TelegramClient(env.BOT_TOKEN);

    await refreshPinnedQueueMessage(env, telegram, userId, 99);

    const editCalls = calls.filter((c) => c.method === "editMessageText");
    const sendCalls = calls.filter((c) => c.method === "sendMessage");
    const pinCalls = calls.filter((c) => c.method === "pinChatMessage");
    expect(editCalls).toHaveLength(1); // tried the old one first
    expect(sendCalls).toHaveLength(1); // then fell back to a fresh message
    expect(pinCalls).toHaveLength(1);

    const row = await env.DB.prepare("SELECT pinned_queue_message_id FROM users WHERE telegram_user_id = ?")
      .bind(userId)
      .first<{ pinned_queue_message_id: number | null }>();
    expect(row!.pinned_queue_message_id).not.toBe(99); // replaced with the new one
  });

  it("refreshPinnedQueueMessageForUser reads the current pinned_queue_message_id from D1 itself", async () => {
    const userId = await makeUser(env);
    await setPinnedQueueMessage(env, userId, 7);
    const telegram = new TelegramClient(env.BOT_TOKEN);

    await refreshPinnedQueueMessageForUser(env, telegram, userId);

    const editCalls = calls.filter((c) => c.method === "editMessageText");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]!.body.message_id).toBe(7);
  });

  it("does nothing for an unregistered user, and does not throw", async () => {
    const telegram = new TelegramClient(env.BOT_TOKEN);
    await expect(refreshPinnedQueueMessageForUser(env, telegram, 123_999_999)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does nothing for a blocked user (no point pinning a message they can't see)", async () => {
    const userId = await makeUser(env);
    await env.DB.prepare("UPDATE users SET blocked = 1 WHERE telegram_user_id = ?").bind(userId).run();
    const telegram = new TelegramClient(env.BOT_TOKEN);

    await refreshPinnedQueueMessageForUser(env, telegram, userId);

    expect(calls).toHaveLength(0);
    expect(await pinnedMessageIdOf(userId)).toBeNull();
  });
});

describe("pinnedQueueViewerIds", () => {
  it("only returns non-blocked users who already have a pinned message", async () => {
    const noPin = await makeUser(env);
    const pinned = await makeUser(env);
    await setPinnedQueueMessage(env, pinned, 1);
    const pinnedButBlocked = await makeUser(env);
    await setPinnedQueueMessage(env, pinnedButBlocked, 2);
    await env.DB.prepare("UPDATE users SET blocked = 1 WHERE telegram_user_id = ?").bind(pinnedButBlocked).run();

    const viewers = await pinnedQueueViewerIds(env);
    expect(viewers).toContain(pinned);
    expect(viewers).not.toContain(noPin);
    expect(viewers).not.toContain(pinnedButBlocked);
  });
});

async function pinnedMessageIdOf(telegramUserId: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT pinned_queue_message_id FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ pinned_queue_message_id: number | null }>();
  return row?.pinned_queue_message_id ?? null;
}
