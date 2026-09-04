import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WEEKLY_SCHEDULE } from "../src/config";
import { ensureCreatedAndOpened, finalizeConsultation, reconcile } from "../src/db/consultations";
import { signupUser } from "../src/db/queue";
import { createOpenConsultation, getUserStatus, makeUser } from "./helpers";

const WED = WEEKLY_SCHEDULE.find((e) => e.name === "Среда")!;
const FRI = WEEKLY_SCHEDULE.find((e) => e.name === "Пятница")!;

async function countConsultations(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM consultations").first<{ c: number }>();
  return row!.c;
}

describe("ensureCreatedAndOpened", () => {
  it("creates a new consultation and opens it on first call", async () => {
    const scheduledAt = new Date("2026-10-07T07:30:00.000Z");
    const opensAt = new Date("2026-10-07T06:30:00.000Z");
    const result = await ensureCreatedAndOpened(env, "Среда", scheduledAt, opensAt);
    expect(result.created).toBe(true);
    expect(result.justOpened).toBe(true);
  });

  it("TEST20 (extra): calling again for the same slot never duplicates or re-broadcasts", async () => {
    const scheduledAt = new Date("2026-10-09T07:30:00.000Z");
    const opensAt = new Date("2026-10-09T06:30:00.000Z");
    const first = await ensureCreatedAndOpened(env, "Пятница", scheduledAt, opensAt);
    const second = await ensureCreatedAndOpened(env, "Пятница", scheduledAt, opensAt);
    expect(first.created).toBe(true);
    expect(first.justOpened).toBe(true);
    expect(second.created).toBe(false);
    expect(second.justOpened).toBe(false);
    expect(second.consultationId).toBe(first.consultationId);
  });
});

describe("finalizeConsultation", () => {
  it("TEST7/TEST8: toggles status only for users with an active (non-cancelled) signup", async () => {
    const consultationId = await createOpenConsultation(env);
    const stayedPriority = await makeUser(env, { priorityStatus: "PRIORITY" });
    const stayedRestricted = await makeUser(env, { priorityStatus: "RESTRICTED" });
    await signupUser(env, consultationId, stayedPriority);
    await signupUser(env, consultationId, stayedRestricted);

    const result = await finalizeConsultation(env, consultationId);
    expect(result.alreadyFinalized).toBe(false);
    expect(new Set(result.toggledUserIds)).toEqual(new Set([stayedPriority, stayedRestricted]));
    expect(await getUserStatus(env, stayedPriority)).toBe("RESTRICTED");
    expect(await getUserStatus(env, stayedRestricted)).toBe("PRIORITY");
  });

  it("a cancelled signup does NOT toggle status (cancellation never changes status)", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env, { priorityStatus: "PRIORITY" });
    await signupUser(env, consultationId, userId);
    const { cancelSignup } = await import("../src/db/queue");
    await cancelSignup(env, consultationId, userId);

    const result = await finalizeConsultation(env, consultationId);
    expect(result.toggledUserIds).not.toContain(userId);
    expect(await getUserStatus(env, userId)).toBe("PRIORITY"); // unchanged
  });

  it("a user who never signed up (skipped the consultation) keeps their status", async () => {
    const consultationId = await createOpenConsultation(env);
    const skipper = await makeUser(env, { priorityStatus: "RESTRICTED" });
    await finalizeConsultation(env, consultationId);
    expect(await getUserStatus(env, skipper)).toBe("RESTRICTED");
  });

  it("TEST17: finalizing the same consultation twice is idempotent -- no double toggle", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env, { priorityStatus: "PRIORITY" });
    await signupUser(env, consultationId, userId);

    const first = await finalizeConsultation(env, consultationId);
    const second = await finalizeConsultation(env, consultationId);
    expect(first.alreadyFinalized).toBe(false);
    expect(second.alreadyFinalized).toBe(true);
    expect(await getUserStatus(env, userId)).toBe("RESTRICTED"); // toggled exactly once
  });

  it("TEST17 (concurrent): finalizing the same consultation from 10 concurrent callers toggles exactly once", async () => {
    const consultationId = await createOpenConsultation(env);
    const userId = await makeUser(env, { priorityStatus: "PRIORITY" });
    await signupUser(env, consultationId, userId);

    const results = await Promise.all(Array.from({ length: 10 }, () => finalizeConsultation(env, consultationId)));
    const wonCount = results.filter((r) => !r.alreadyFinalized).length;
    expect(wonCount).toBe(1);
    expect(await getUserStatus(env, userId)).toBe("RESTRICTED");
  });
});

describe("reconcile", () => {
  it("TEST18 (integration): reconcile() at exactly Wednesday 09:30 MSK creates and opens exactly one consultation", async () => {
    // A date not otherwise used in this file -- storage persists across
    // tests within a file, so every fixed calendar date used to create a
    // consultation anywhere in this file must be unique.
    const now = new Date("2027-01-06T06:30:00.000Z"); // Wednesday 09:30 MSK
    const report = await reconcile(env, now);
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]!.created).toBe(true);
    expect(report.opened[0]!.justOpened).toBe(true);
  });

  it("TEST19 (integration): reconcile() at exactly Friday 09:30 MSK creates and opens exactly one consultation", async () => {
    const now = new Date("2027-01-08T06:30:00.000Z"); // Friday 09:30 MSK
    const report = await reconcile(env, now);
    expect(report.opened).toHaveLength(1);
  });

  it("TEST20: reconcile() before the opening moment creates nothing", async () => {
    const now = new Date("2026-10-05T05:00:00.000Z"); // Monday 08:00 MSK -- well before either slot
    const before = await countConsultations();
    const report = await reconcile(env, now);
    expect(report.opened).toHaveLength(0);
    expect(await countConsultations()).toBe(before);
  });

  it("TEST20 (extra): repeated reconcile calls never duplicate or re-broadcast the same slot", async () => {
    const wed = new Date("2026-11-04T06:30:00.000Z"); // a Wednesday, 09:30 MSK
    const first = await reconcile(env, wed);
    const second = await reconcile(env, new Date(wed.getTime() + 5 * 60_000));
    const third = await reconcile(env, new Date(wed.getTime() + 2 * 3_600_000)); // +2h, after class time
    expect(first.opened).toHaveLength(1);
    expect(second.opened).toHaveLength(0);
    expect(third.opened).toHaveLength(0);
  });

  it("regression: reconcile() for the FIRST time on a class day, AFTER class time has passed, creates nothing", async () => {
    // The bug this guards against: deploying for the first time at 15:00 on
    // a Friday must not open registration for the 10:30 class that already
    // happened that same morning -- the original calendar-day-only bound
    // would have let this slip through.
    const fri1500 = new Date("2026-11-06T12:00:00.000Z"); // Friday 15:00 MSK
    const before = await countConsultations();
    const report = await reconcile(env, fri1500);
    expect(report.opened).toHaveLength(0);
    expect(await countConsultations()).toBe(before);
  });

  it("regression: a mid-day restart still finishes opening a slot created earlier that same day", async () => {
    const opensTime = new Date("2026-11-13T06:30:00.000Z"); // Friday 09:30 MSK
    const first = await reconcile(env, opensTime);
    expect(first.opened).toHaveLength(1);

    // Simulate a restart at 15:30 MSK, well after the 10:30 class time --
    // must recognize the already-created slot, not skip it or duplicate it.
    const later = new Date(opensTime.getTime() + 6 * 3_600_000);
    const second = await reconcile(env, later);
    expect(second.opened).toHaveLength(0); // already open -- nothing new, but no error
  });

  it("TEST21: finalizing the previous consultation and opening the next starts with an empty queue", async () => {
    // Use a Wednesday well in the past relative to the Friday below so the
    // date-bound finalize logic picks it up.
    const wedOpen = new Date("2026-12-02T06:30:00.000Z"); // Wednesday 09:30 MSK
    const first = await reconcile(env, wedOpen);
    const oldConsultationId = first.opened[0]!.consultationId;

    const userId = await makeUser(env);
    await signupUser(env, oldConsultationId, userId);

    // "Next day" -- reconcile at Friday's opening moment finalizes Wednesday and opens Friday.
    const friOpen = new Date("2026-12-04T06:30:00.000Z"); // Friday 09:30 MSK
    const second = await reconcile(env, friOpen);
    expect(second.finalized.map((f) => f.consultationId)).toContain(oldConsultationId);
    expect(second.opened).toHaveLength(1);

    const newConsultationId = second.opened[0]!.consultationId;
    expect(newConsultationId).not.toBe(oldConsultationId);

    const { getQueueView } = await import("../src/db/queue");
    const entries = await getQueueView(env, newConsultationId);
    expect(entries.every((e) => e.isPlaceholder)).toBe(true); // empty except reserved placeholders
  });
});
