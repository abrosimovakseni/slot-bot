import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

async function countConsultations(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM consultations").first<{ c: number }>();
  return row!.c;
}

async function runScheduled(scheduledTime: Date, targetEnv: Env = env, cron?: string): Promise<void> {
  const controller = createScheduledController({ scheduledTime, cron });
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

  it("Cron субботы: the Saturday 06:30 UTC (09:30 MSK) trigger creates and opens exactly one consultation, curator Боремир Иванович", async () => {
    const before = await countConsultations();
    await runScheduled(new Date("2027-02-06T06:30:00.000Z")); // Saturday 09:30 MSK
    expect(await countConsultations()).toBe(before + 1);

    const row = await env.DB.prepare("SELECT * FROM consultations WHERE scheduled_at = ?")
      .bind(new Date("2027-02-06T07:30:00.000Z").toISOString())
      .first<{ opened_notified_at: string | null; curator: string; room: string }>();
    expect(row).not.toBeNull();
    expect(row!.opened_notified_at).not.toBeNull();
    expect(row!.curator).toBe("Боремир Иванович");
    expect(row!.room).toBe("324");
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

describe("scheduled(): webhook self-heal (cron '*/15 * * * *')", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-asserts the Telegram webhook with the current URL and secret -- never touches D1 or students", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));

    const before = await countConsultations();
    // Deliberately a moment when the Wednesday slot would otherwise be due,
    // to prove this branch does NOT run reconcile() at all.
    await runScheduled(new Date("2027-05-05T06:30:00.000Z"), env, "*/15 * * * *"); // also a Wednesday 09:30 MSK
    expect(await countConsultations()).toBe(before); // untouched -- reconcile() never ran

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(String(calledUrl)).toBe(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`);
    const body = JSON.parse((calledInit as RequestInit).body as string);
    expect(body.url).toBe(`${env.WORKER_URL}/webhook`);
    expect(body.secret_token).toBe(env.WEBHOOK_SECRET);
  });

  it("a failed re-assert is caught and reported to the admin, never thrown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      runScheduled(new Date("2027-05-07T02:00:00.000Z"), env, "*/15 * * * *"),
    ).resolves.toBeUndefined();
  });
});
