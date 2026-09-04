import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

async function countConsultations(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM consultations").first<{ c: number }>();
  return row!.c;
}

async function runScheduled(scheduledTime: Date, targetEnv: Env = env): Promise<void> {
  const controller = createScheduledController({ scheduledTime });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, targetEnv, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled(): Cron Triggers", () => {
  it("Cron среды: the Wednesday 06:30 UTC (09:30 MSK) trigger creates and opens exactly one consultation", async () => {
    const before = await countConsultations();
    await runScheduled(new Date("2027-02-03T06:30:00.000Z")); // Wednesday 09:30 MSK
    expect(await countConsultations()).toBe(before + 1);

    const row = await env.DB.prepare("SELECT * FROM consultations WHERE scheduled_at = ?")
      .bind(new Date("2027-02-03T07:30:00.000Z").toISOString())
      .first<{ opened_notified_at: string | null; finalized_at: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.opened_notified_at).not.toBeNull();
    expect(row!.finalized_at).toBeNull();
  });

  it("Cron пятницы: the Friday 06:30 UTC (09:30 MSK) trigger creates and opens exactly one consultation", async () => {
    const before = await countConsultations();
    await runScheduled(new Date("2027-02-05T06:30:00.000Z")); // Friday 09:30 MSK
    expect(await countConsultations()).toBe(before + 1);
  });

  it("повторный Cron: firing the same precise trigger again is a safe no-op (no duplicate, no re-broadcast)", async () => {
    const scheduledTime = new Date("2027-03-10T06:30:00.000Z"); // a fresh Wednesday
    const before = await countConsultations();
    await runScheduled(scheduledTime);
    expect(await countConsultations()).toBe(before + 1);

    // Telegram retries deliveries, deploys restart mid-window, and the
    // once-a-minute safety-net tick can all land on a slot that's already
    // open -- none of them may create a second row or re-fire the broadcast.
    await runScheduled(new Date(scheduledTime.getTime() + 60_000));
    await runScheduled(new Date(scheduledTime.getTime() + 5 * 60_000));
    expect(await countConsultations()).toBe(before + 1);
  });

  it("safety-net tick (every minute) catches up on an opening the precise trigger missed", async () => {
    // Simulate the precise 06:30 trigger never firing (a deploy in progress,
    // a transient platform error) -- a later safety-net tick (15 min out,
    // to make the "definitely missed" scenario unambiguous here) must still
    // open the slot using the exact same idempotent path.
    const missedOpen = new Date("2027-03-12T06:45:00.000Z"); // Friday, 15 min after the precise trigger
    const before = await countConsultations();
    await runScheduled(missedOpen);
    expect(await countConsultations()).toBe(before + 1);

    const row = await env.DB.prepare("SELECT opened_notified_at FROM consultations WHERE scheduled_at = ?")
      .bind(new Date("2027-03-12T07:30:00.000Z").toISOString())
      .first<{ opened_notified_at: string | null }>();
    expect(row!.opened_notified_at).not.toBeNull();
  });

  it("a reconcile() failure is caught -- the trigger never throws, so Cloudflare never retries it forever", async () => {
    const throwingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return () => {
            throw new Error("simulated D1 outage");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const brokenEnv: Env = { ...env, DB: throwingDb };

    await expect(runScheduled(new Date("2027-04-07T06:30:00.000Z"), brokenEnv)).resolves.toBeUndefined();
  });
});
