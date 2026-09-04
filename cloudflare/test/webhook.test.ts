import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createOpenConsultation, makeUser } from "./helpers";

const SECRET = env.WEBHOOK_SECRET;

/**
 * Sentinel for "send no secret header at all". A plain `undefined` default
 * parameter can't distinguish "caller omitted the argument" (use SECRET)
 * from "caller explicitly passed undefined" (also uses the default in JS,
 * per spec) -- so the missing-secret test needs its own unambiguous value.
 */
const OMIT_SECRET = Symbol("omit-secret");

function webhookRequest(body: unknown, secret: string | typeof OMIT_SECRET = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== OMIT_SECRET) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let nextUpdateId = 1;
function freshUpdateId(): number {
  return nextUpdateId++;
}

describe("fetch: webhook security", () => {
  it("rejects a request with a missing secret token", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(webhookRequest({ update_id: freshUpdateId() }, OMIT_SECRET), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
  });

  it("rejects a request with the wrong secret token", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(webhookRequest({ update_id: freshUpdateId() }, "wrong-secret"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(403);
  });

  it("GET / is a plain health check, no secret required", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(new Request("https://example.com/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
  });

  it("unknown paths 404", async () => {
    const ctx = createExecutionContext();
    const resp = await worker.fetch(new Request("https://example.com/nope"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(404);
  });
});

describe("fetch: registration flow end-to-end through the webhook", () => {
  it("full flow: /start -> type name -> confirm -> registered with main menu access", async () => {
    const telegramUserId = 700_000_001;

    // 1. /start for a brand-new user.
    let ctx = createExecutionContext();
    let resp = await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        message: { message_id: 1, chat: { id: telegramUserId }, from: { id: telegramUserId, username: "newbie" }, text: "/start" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);

    let state = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<{ flow: string; state: string }>();
    expect(state?.flow).toBe("register");
    expect(state?.state).toBe("ASK_NAME");

    let user = await env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(telegramUserId).first();
    expect(user).toBeNull(); // not registered yet -- only after confirming

    // 2. Types their name.
    ctx = createExecutionContext();
    resp = await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        message: { message_id: 2, chat: { id: telegramUserId }, from: { id: telegramUserId }, text: "Иван Иванов" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);

    state = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<{ flow: string; state: string; pending_name: string }>();
    expect(state?.state).toBe("CONFIRM_NAME");
    expect((state as unknown as { pending_name: string }).pending_name).toBe("Иван Иванов");

    // 3. Confirms with "Да".
    ctx = createExecutionContext();
    resp = await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        callback_query: {
          id: "cbq1",
          from: { id: telegramUserId, username: "newbie" },
          message: { message_id: 3, chat: { id: telegramUserId } },
          data: "name_confirm_yes",
        },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);

    user = await env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<{ display_name: string; priority_status: string }>();
    expect((user as unknown as { display_name: string }).display_name).toBe("Иван Иванов");
    expect((user as unknown as { priority_status: string }).priority_status).toBe("PRIORITY");

    state = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first();
    expect(state).toBeNull(); // state cleared after successful registration
  });

  it("'Изменить' during confirm goes back to asking for the name again", async () => {
    const telegramUserId = 700_000_002;
    let ctx = createExecutionContext();
    await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        message: { message_id: 1, chat: { id: telegramUserId }, from: { id: telegramUserId }, text: "/start" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    ctx = createExecutionContext();
    await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        message: { message_id: 2, chat: { id: telegramUserId }, from: { id: telegramUserId }, text: "Wrong Name" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    ctx = createExecutionContext();
    await worker.fetch(
      webhookRequest({
        update_id: freshUpdateId(),
        callback_query: {
          id: "cbq1",
          from: { id: telegramUserId },
          message: { message_id: 3, chat: { id: telegramUserId } },
          data: "name_confirm_edit",
        },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const state = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
      .bind(telegramUserId)
      .first<{ state: string }>();
    expect((state as unknown as { state: string }).state).toBe("ASK_NAME");

    const user = await env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(telegramUserId).first();
    expect(user).toBeNull(); // never registered -- they backed out
  });
});

describe("fetch: idempotent webhook delivery", () => {
  it("redelivering the exact same update_id does not reprocess it", async () => {
    const telegramUserId = await makeUser(env);
    const consultationId = await createOpenConsultation(env);
    const updateId = freshUpdateId();
    const body = {
      update_id: updateId,
      callback_query: {
        id: "cbq-dup",
        from: { id: telegramUserId },
        message: { message_id: 1, chat: { id: telegramUserId } },
        data: `signup:${consultationId}`,
      },
    };

    let ctx = createExecutionContext();
    await worker.fetch(webhookRequest(body), env, ctx);
    await waitOnExecutionContext(ctx);

    ctx = createExecutionContext();
    await worker.fetch(webhookRequest(body), env, ctx); // Telegram retries the same update_id
    await waitOnExecutionContext(ctx);

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM signups WHERE consultation_id = ? AND user_id = ? AND active = 1",
    )
      .bind(consultationId, telegramUserId)
      .all<{ c: number }>();
    expect(results[0]!.c).toBe(1);
  });
});
