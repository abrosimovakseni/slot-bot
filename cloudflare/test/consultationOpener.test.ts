/**
 * Tests for the ConsultationOpener Durable Object (src/consultationOpener.ts)
 * and its db-layer counterpart, openOneConsultationNow() -- the exact-time
 * opening path for admin one-off consultations (see that file's doc
 * comment for the full why).
 *
 * `runDurableObjectAlarm(stub)` (from `cloudflare:test`) fires a scheduled
 * alarm immediately regardless of the real clock or the time it was set
 * for, so these tests don't need to wait around for real time to pass --
 * they only need the consultation's own registration_opens_at (compared
 * against the real `now` inside the alarm handler) to already be due.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { cancelOpenAlarm, scheduleOpenAlarm } from "../src/consultationOpener";
import { deleteConsultation, openOneConsultationNow } from "../src/db/consultations";
import type { NotifyMessage } from "../src/types";
import { createDueUnopenedConsultation, createOpenConsultation, createUnopenedConsultation, makeUser } from "./helpers";

function stubFor(consultationId: number) {
  const id = env.CONSULTATION_OPENER.idFromName(String(consultationId));
  return env.CONSULTATION_OPENER.get(id);
}

function openingTargets(sendBatchCalls: unknown[][]): number[] {
  const ids: number[] = [];
  for (const call of sendBatchCalls) {
    const batch = call[0] as Array<{ body: NotifyMessage }>;
    for (const { body } of batch) {
      if (body.kind === "opening") ids.push(body.consultationId);
    }
  }
  return ids;
}

describe("openOneConsultationNow", () => {
  it("claims a due, unopened consultation and enqueues its opening broadcast", async () => {
    const consultationId = await createDueUnopenedConsultation(env, "Готова к открытию");
    await makeUser(env); // enqueueOpeningBroadcast fans out to every non-blocked user
    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");

    await openOneConsultationNow(env, consultationId);

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ opened_notified_at: string | null }>();
    expect(row!.opened_notified_at).not.toBeNull();
    expect(openingTargets(sendBatchSpy.mock.calls)).toContain(consultationId);
    sendBatchSpy.mockRestore();
  });

  it("does nothing for a consultation that isn't due yet", async () => {
    const consultationId = await createUnopenedConsultation(env, "Ещё рано");
    await openOneConsultationNow(env, consultationId);

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ opened_notified_at: string | null }>();
    expect(row!.opened_notified_at).toBeNull();
  });

  it("is a safe no-op (never double-broadcasts) if the consultation was already opened", async () => {
    const consultationId = await createOpenConsultation(env, "Уже открыта");
    await openOneConsultationNow(env, consultationId);

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await openOneConsultationNow(env, consultationId); // second call -- e.g. sweep and alarm racing
    expect(sendBatchSpy).not.toHaveBeenCalled();
    sendBatchSpy.mockRestore();
  });

  it("is a safe no-op if the consultation row is gone (cancelled before the alarm fired)", async () => {
    const consultationId = await createOpenConsultation(env, "Отменена до открытия");
    await deleteConsultation(env, consultationId);

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    await expect(openOneConsultationNow(env, consultationId)).resolves.toBeUndefined();
    expect(sendBatchSpy).not.toHaveBeenCalled();
    sendBatchSpy.mockRestore();
  });
});

describe("ConsultationOpener Durable Object", () => {
  it("scheduleOpenAlarm sets an alarm that, once fired, opens the consultation", async () => {
    const consultationId = await createDueUnopenedConsultation(env, "По будильнику");
    await makeUser(env); // enqueueOpeningBroadcast fans out to every non-blocked user
    const stub = stubFor(consultationId);

    await scheduleOpenAlarm(env, consultationId, new Date(Date.now() + 60_000)); // set for a minute from now
    const alarmScheduled = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarmScheduled).not.toBeNull();

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    const ran = await runDurableObjectAlarm(stub); // fires immediately regardless of the set time
    expect(ran).toBe(true);

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ opened_notified_at: string | null }>();
    expect(row!.opened_notified_at).not.toBeNull();
    expect(openingTargets(sendBatchSpy.mock.calls)).toContain(consultationId);
    sendBatchSpy.mockRestore();
  });

  it("cancelOpenAlarm removes a scheduled alarm before it fires", async () => {
    const consultationId = await createUnopenedConsultation(env, "Отменённый будильник");
    const stub = stubFor(consultationId);

    await scheduleOpenAlarm(env, consultationId, new Date(Date.now() + 60_000));
    await cancelOpenAlarm(env, consultationId);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(false); // nothing was scheduled to run

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE id = ?")
      .bind(consultationId)
      .first<{ opened_notified_at: string | null }>();
    expect(row!.opened_notified_at).toBeNull(); // never opened
  });

  it("firing the alarm for a since-cancelled (deleted) consultation is a safe no-op", async () => {
    const consultationId = await createOpenConsultation(env, "Удалена до будильника");
    const stub = stubFor(consultationId);
    await scheduleOpenAlarm(env, consultationId, new Date(Date.now() + 60_000));
    await deleteConsultation(env, consultationId); // admin cancelled it, but didn't reach cancelOpenAlarm in this test

    const sendBatchSpy = vi.spyOn(env.NOTIFY_QUEUE, "sendBatch");
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true); // the alarm itself still fires...
    expect(sendBatchSpy).not.toHaveBeenCalled(); // ...but there's nothing left to open or broadcast
    sendBatchSpy.mockRestore();
  });
});
