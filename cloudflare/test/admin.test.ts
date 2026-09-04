import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listUpcomingConsultations } from "../src/db/consultations";
import { signupUser } from "../src/db/queue";
import worker from "../src/index";
import { isAdmin } from "../src/bot/handlers/admin";
import { BTN_ADMIN } from "../src/bot/texts";
import type { UserStateRow } from "../src/types";
import { createOpenConsultation, makeUser } from "./helpers";

const ADMIN_ID = Number(env.ADMIN_ID); // "1", set in vitest.config.ts -- outside makeUser()'s id range
const NON_ADMIN_ID = 777;

let nextUpdateId = 1;
function freshUpdateId(): number {
  return nextUpdateId++;
}

function webhookMessage(fromId: number, text: string) {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: freshUpdateId(),
      message: { message_id: 1, chat: { id: fromId }, from: { id: fromId }, text },
    }),
  });
}

function webhookCallback(fromId: number, data: string) {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: freshUpdateId(),
      callback_query: {
        id: `cbq-${Date.now()}-${Math.random()}`,
        from: { id: fromId },
        message: { message_id: 1, chat: { id: fromId } },
        data,
      },
    }),
  });
}

async function post(request: Request): Promise<void> {
  const ctx = createExecutionContext();
  const resp = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(resp.status).toBe(200);
}

async function getUserState(telegramUserId: number): Promise<UserStateRow | null> {
  const row = await env.DB.prepare("SELECT * FROM user_state WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<UserStateRow>();
  return row ?? null;
}

describe("isAdmin", () => {
  it("is true only for env.ADMIN_ID", () => {
    expect(isAdmin(env, ADMIN_ID)).toBe(true);
    expect(isAdmin(env, NON_ADMIN_ID)).toBe(false);
  });

  it("is false when ADMIN_ID is unset or blank", () => {
    expect(isAdmin({ ...env, ADMIN_ID: undefined }, ADMIN_ID)).toBe(false);
    expect(isAdmin({ ...env, ADMIN_ID: "" }, ADMIN_ID)).toBe(false);
  });
});

describe("admin menu access control", () => {
  it("a non-admin sending the admin button label or an admin callback triggers nothing", async () => {
    await post(webhookMessage(NON_ADMIN_ID, BTN_ADMIN));
    await post(webhookCallback(NON_ADMIN_ID, "admin_add_start"));

    // No admin_add state ever got created for the impostor.
    expect(await getUserState(NON_ADMIN_ID)).toBeNull();
  });
});

describe("admin: create a one-off consultation end-to-end", () => {
  it("add -> type datetime -> confirm creates and opens a consultation", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    let state = await getUserState(ADMIN_ID);
    expect(state?.flow).toBe("admin_add");
    expect(state?.state).toBe("ASK_DATETIME");

    await post(webhookMessage(ADMIN_ID, "20.09.2030 15:00"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("CONFIRM_DATETIME");
    expect(state?.pending_name).toBe("2030-09-20T12:00:00.000Z"); // 15:00 MSK -> 12:00 UTC

    await post(webhookCallback(ADMIN_ID, "admin_create_yes"));
    expect(await getUserState(ADMIN_ID)).toBeNull(); // state cleared after creating

    const row = await env.DB.prepare(
      "SELECT * FROM consultations WHERE scheduled_at = ?",
    )
      .bind("2030-09-20T12:00:00.000Z")
      .first<{ id: number; opened_notified_at: string | null; finalized_at: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.opened_notified_at).not.toBeNull(); // opened immediately, no waiting for a cron
    expect(row!.finalized_at).toBeNull();
  });

  it("an invalid datetime is rejected and the flow stays at ASK_DATETIME", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "not a date"));
    const state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("ASK_DATETIME"); // never advanced

    // Clean up so this test's leftover state doesn't leak into later ones.
    await post(webhookCallback(ADMIN_ID, "admin_create_no"));
  });

  it("a past datetime is rejected", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "01.01.2020 12:00"));
    const state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("ASK_DATETIME");
    await post(webhookCallback(ADMIN_ID, "admin_create_no"));
  });

  it("'Отмена' aborts without creating a consultation", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) as c FROM consultations WHERE scheduled_at = ?")
      .bind("2031-05-01T09:00:00.000Z")
      .first<{ c: number }>();

    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "01.05.2031 12:00"));
    await post(webhookCallback(ADMIN_ID, "admin_create_no"));

    expect(await getUserState(ADMIN_ID)).toBeNull();
    const after = await env.DB.prepare("SELECT COUNT(*) as c FROM consultations WHERE scheduled_at = ?")
      .bind("2031-05-01T09:00:00.000Z")
      .first<{ c: number }>();
    expect(after!.c).toBe(before!.c); // unchanged -- nothing was created
  });
});

describe("admin: cancel a consultation end-to-end", () => {
  it("pick -> confirm deletes the consultation and its signups, listed as no longer upcoming", async () => {
    const consultationId = await createOpenConsultation(env, "Отменяемая");
    const studentId = await makeUser(env);
    await signupUser(env, consultationId, studentId);

    await post(webhookCallback(ADMIN_ID, "admin_cancel_list"));
    await post(webhookCallback(ADMIN_ID, `admin_cancel_pick:${consultationId}`));
    await post(webhookCallback(ADMIN_ID, `admin_cancel_yes:${consultationId}`));

    const gone = await env.DB.prepare("SELECT id FROM consultations WHERE id = ?").bind(consultationId).first();
    expect(gone).toBeNull();
    const { results: signupRows } = await env.DB.prepare("SELECT id FROM signups WHERE consultation_id = ?")
      .bind(consultationId)
      .all();
    expect(signupRows).toHaveLength(0);

    const upcoming = await listUpcomingConsultations(env);
    expect(upcoming.map((c) => c.id)).not.toContain(consultationId);
  });

  it("cancelling an already-cancelled (or nonexistent) consultation id is a safe no-op", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_cancel_yes:999999999"));
    // No throw, no 500 -- `post()` already asserted status 200.
  });

  it("'Нет' during the cancel confirmation leaves the consultation untouched", async () => {
    const consultationId = await createOpenConsultation(env, "Оставить как есть");
    await post(webhookCallback(ADMIN_ID, `admin_cancel_pick:${consultationId}`));
    await post(webhookCallback(ADMIN_ID, `admin_cancel_no:${consultationId}`));

    const still = await env.DB.prepare("SELECT id FROM consultations WHERE id = ?").bind(consultationId).first();
    expect(still).not.toBeNull();
  });
});
