import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { scheduleOpenAlarm } from "../src/consultationOpener";
import { listUpcomingConsultations } from "../src/db/consultations";
import { signupUser } from "../src/db/queue";
import worker from "../src/index";
import { isAdmin } from "../src/bot/handlers/admin";
import { BTN_ADMIN } from "../src/bot/texts";
import { formatMoscowDateTime } from "../src/timeUtils";
import type { NotifyMessage, UserStateRow } from "../src/types";
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
  it("add -> type a far-future datetime -> confirm creates it unopened, registration due one hour before class", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    let state = await getUserState(ADMIN_ID);
    expect(state?.flow).toBe("admin_add");
    expect(state?.state).toBe("ASK_DATETIME");

    await post(webhookMessage(ADMIN_ID, "20.09.2030 15:00"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("CURATOR_ROOM_CHOICE");
    expect(state?.pending_name).toBe("2030-09-20T12:00:00.000Z"); // 15:00 MSK -> 12:00 UTC

    // "Как обычно" -- accept the default curator/room without typing anything.
    await post(webhookCallback(ADMIN_ID, "admin_curator_default"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("CONFIRM_DATETIME");

    await post(webhookCallback(ADMIN_ID, "admin_create_yes"));
    expect(await getUserState(ADMIN_ID)).toBeNull(); // state cleared after creating

    const row = await env.DB.prepare(
      "SELECT * FROM consultations WHERE scheduled_at = ?",
    )
      .bind("2030-09-20T12:00:00.000Z")
      .first<{
        id: number;
        registration_opens_at: string;
        opened_notified_at: string | null;
        finalized_at: string | null;
        curator: string;
        room: string;
      }>();
    expect(row).not.toBeNull();
    // Not open yet -- this is 2030, registration only opens one hour before
    // the 15:00 MSK class, i.e. 11:00 UTC, same lead time as the regular
    // Wed/Fri schedule (see config.ADMIN_CONSULTATION_LEAD_MS).
    expect(row!.registration_opens_at).toBe("2030-09-20T11:00:00.000Z");
    expect(row!.opened_notified_at).toBeNull();
    expect(row!.finalized_at).toBeNull();
    expect(row!.curator).toBe("Любовь Котлярова");
    expect(row!.room).toBe("332");

    // Not opened immediately -- confirmCreateConsultationYes must have
    // scheduled the exact-time opening alarm instead (see
    // src/consultationOpener.ts), for exactly the row's own opens_at.
    const openerId = env.CONSULTATION_OPENER.idFromName(String(row!.id));
    const stub = env.CONSULTATION_OPENER.get(openerId);
    const alarmTime = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarmTime).toBe(new Date(row!.registration_opens_at).getTime());
  });

  it("add -> type a datetime -> 'Указать другое' -> type curator and room -> confirm creates it with those values", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "21.09.2030 16:00"));
    expect((await getUserState(ADMIN_ID))?.state).toBe("CURATOR_ROOM_CHOICE");

    await post(webhookCallback(ADMIN_ID, "admin_curator_custom"));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_CURATOR");

    await post(webhookMessage(ADMIN_ID, "Иван Иванов"));
    let state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("ASK_ROOM");
    expect(state?.pending_extra).toBe(JSON.stringify({ curator: "Иван Иванов" }));

    await post(webhookMessage(ADMIN_ID, "404"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("CONFIRM_DATETIME");
    expect(state?.pending_extra).toBe(JSON.stringify({ curator: "Иван Иванов", room: "404" }));

    await post(webhookCallback(ADMIN_ID, "admin_create_yes"));
    expect(await getUserState(ADMIN_ID)).toBeNull();

    const row = await env.DB.prepare("SELECT curator, room FROM consultations WHERE scheduled_at = ?")
      .bind("2030-09-21T13:00:00.000Z")
      .first<{ curator: string; room: string }>();
    expect(row).not.toBeNull();
    expect(row!.curator).toBe("Иван Иванов");
    expect(row!.room).toBe("404");
  });

  it("an empty curator name or room is rejected and re-prompted", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "22.09.2030 16:00"));
    await post(webhookCallback(ADMIN_ID, "admin_curator_custom"));

    await post(webhookMessage(ADMIN_ID, "   "));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_CURATOR"); // never advanced

    await post(webhookMessage(ADMIN_ID, "Куратор"));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_ROOM");

    await post(webhookMessage(ADMIN_ID, ""));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_ROOM"); // still stuck, empty room rejected

    await post(webhookCallback(ADMIN_ID, "admin_add_cancel"));
    expect(await getUserState(ADMIN_ID)).toBeNull();
  });

  it("creating one for less than an hour from now opens it immediately, same as before", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    const soon = new Date(Date.now() + 20 * 60_000); // 20 minutes out -- inside the 1-hour lead window
    // Build the "DD.MM.YYYY HH:MM" (Moscow) text the same way the curator
    // would type it, using the same helper the app itself uses to render
    // dates back to her.
    const text = formatMoscowDateTime(soon);

    await post(webhookMessage(ADMIN_ID, text));
    await post(webhookCallback(ADMIN_ID, "admin_create_yes"));

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE label = ?")
      .bind(text)
      .first<{ opened_notified_at: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.opened_notified_at).not.toBeNull(); // due already -- opened right away, no waiting for a cron
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

  it("'◀️ Отмена' on the date/time prompt itself backs out before typing anything", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_DATETIME");

    await post(webhookCallback(ADMIN_ID, "admin_add_cancel"));
    expect(await getUserState(ADMIN_ID)).toBeNull();
  });

  it("'◀️ Отмена' also works after a failed (invalid) attempt", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_add_start"));
    await post(webhookMessage(ADMIN_ID, "garbage"));
    expect((await getUserState(ADMIN_ID))?.state).toBe("ASK_DATETIME"); // still retrying

    await post(webhookCallback(ADMIN_ID, "admin_add_cancel"));
    expect(await getUserState(ADMIN_ID)).toBeNull();
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

  it("cancelling a consultation also cancels its exact-time opening alarm, if it had one", async () => {
    const consultationId = await createOpenConsultation(env, "С будильником");
    await scheduleOpenAlarm(env, consultationId, new Date(Date.now() + 60_000));

    await post(webhookCallback(ADMIN_ID, `admin_cancel_pick:${consultationId}`));
    await post(webhookCallback(ADMIN_ID, `admin_cancel_yes:${consultationId}`));

    const openerId = env.CONSULTATION_OPENER.idFromName(String(consultationId));
    const stub = env.CONSULTATION_OPENER.get(openerId);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(false); // cancelled -- nothing left scheduled to run
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

describe("admin: change curator/room for an existing consultation end-to-end", () => {
  it("pick -> type curator -> type room -> confirm updates the row and notifies active signups", async () => {
    const consultationId = await createOpenConsultation(env, "Куратор меняется");
    const studentId = await makeUser(env);
    await signupUser(env, consultationId, studentId);

    await post(webhookCallback(ADMIN_ID, "admin_edit_details_start"));
    await post(webhookCallback(ADMIN_ID, `admin_edit_pick:${consultationId}`));
    let state = await getUserState(ADMIN_ID);
    expect(state?.flow).toBe("admin_edit_details");
    expect(state?.state).toBe("ASK_CURATOR");
    expect(state?.pending_name).toBe(String(consultationId));

    await post(webhookMessage(ADMIN_ID, "Новый Куратор"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("ASK_ROOM");

    await post(webhookMessage(ADMIN_ID, "101"));
    state = await getUserState(ADMIN_ID);
    expect(state?.state).toBe("CONFIRM_EDIT_DETAILS");

    // Spy on the queue producer rather than notifications_sent -- that table
    // is only populated once the queue *consumer* processes the message
    // (see test/notify.test.ts), which this webhook-only harness never
    // drives on its own (same pattern as test/pinnedQueueWiring.test.ts).
    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await post(webhookCallback(ADMIN_ID, `admin_edit_yes:${consultationId}`));
    expect(await getUserState(ADMIN_ID)).toBeNull();

    const row = await env.DB.prepare("SELECT curator, room FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ curator: string; room: string }>();
    expect(row!.curator).toBe("Новый Куратор");
    expect(row!.room).toBe("101");

    const enqueued: NotifyMessage[] = sendBatchSpy.mock.calls.flatMap((call) =>
      (call[0] as Array<{ body: NotifyMessage }>).map((m) => m.body),
    );
    sendBatchSpy.mockRestore();
    const detailsChangedForStudent = enqueued.find(
      (m) => m.kind === "details_changed" && m.telegramUserId === studentId && m.consultationId === consultationId,
    );
    expect(detailsChangedForStudent).toMatchObject({ curator: "Новый Куратор", room: "101" });
  });

  it("'Отмена' during the edit confirmation leaves the consultation untouched", async () => {
    const consultationId = await createOpenConsultation(env, "Не трогать");
    const before = await env.DB.prepare("SELECT curator, room FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ curator: string; room: string }>();

    await post(webhookCallback(ADMIN_ID, `admin_edit_pick:${consultationId}`));
    await post(webhookMessage(ADMIN_ID, "Кто-то"));
    await post(webhookMessage(ADMIN_ID, "999"));
    await post(webhookCallback(ADMIN_ID, `admin_edit_no:${consultationId}`));

    expect(await getUserState(ADMIN_ID)).toBeNull();
    const after = await env.DB.prepare("SELECT curator, room FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ curator: string; room: string }>();
    expect(after).toEqual(before);
  });

  it("with nothing upcoming, the picker says so instead of showing an empty list", async () => {
    await post(webhookCallback(ADMIN_ID, "admin_edit_details_start"));
    // No throw, no 500 -- `post()` already asserted status 200. There's
    // nothing in D1 to assert on here beyond "it didn't crash", since the
    // NO_UPCOMING_CONSULTATIONS reply isn't observable from this harness.
  });
});
