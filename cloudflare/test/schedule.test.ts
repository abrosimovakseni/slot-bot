import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  addScheduleEntry,
  deleteScheduleEntry,
  getScheduleEntry,
  listActiveScheduleEntries,
  listAllScheduleEntries,
} from "../src/db/schedule";

describe("listActiveScheduleEntries / listAllScheduleEntries (seed data)", () => {
  it("the migration seeds the three original weekly slots, all active", async () => {
    const active = await listActiveScheduleEntries(env);
    expect(active.map((e) => e.name).sort()).toEqual(["Пятница", "Среда", "Суббота"]);

    const sat = active.find((e) => e.name === "Суббота")!;
    expect(sat.curator).toBe("Боремир Иванович");
    expect(sat.room).toBe("324");

    const wed = active.find((e) => e.name === "Среда")!;
    expect(wed.curator).toBeUndefined(); // no override -- falls back to DEFAULT_CURATOR/DEFAULT_ROOM
    expect(wed.room).toBeUndefined();
  });

  it("listAllScheduleEntries includes every seeded row with its D1 id", async () => {
    const all = await listAllScheduleEntries(env);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((e) => typeof e.id === "number")).toBe(true);
  });
});

describe("addScheduleEntry / deleteScheduleEntry / getScheduleEntry", () => {
  it("adds a new active entry with a custom curator/room, retrievable by id", async () => {
    const id = await addScheduleEntry(env, {
      name: "Понедельник",
      weekday: 0,
      classHour: 14,
      classMinute: 0,
      opensHour: 13,
      opensMinute: 0,
      curator: "Тестовый куратор",
      room: "101",
    });
    const row = await getScheduleEntry(env, id);
    expect(row).not.toBeNull();
    expect(row!.weekday).toBe(0);
    expect(row!.class_hour).toBe(14);
    expect(row!.curator).toBe("Тестовый куратор");
    expect(row!.room).toBe("101");
    expect(row!.active).toBe(1);
  });

  it("adds an entry without curator/room ('как обычно') as NULL columns", async () => {
    const id = await addScheduleEntry(env, {
      name: "Вторник",
      weekday: 1,
      classHour: 12,
      classMinute: 0,
      opensHour: 11,
      opensMinute: 0,
    });
    const row = await getScheduleEntry(env, id);
    expect(row!.curator).toBeNull();
    expect(row!.room).toBeNull();
  });

  it("the new entry is included by listActiveScheduleEntries as a ScheduleEntry", async () => {
    const id = await addScheduleEntry(env, {
      name: "Четверг",
      weekday: 3,
      classHour: 16,
      classMinute: 15,
      opensHour: 15,
      opensMinute: 15,
      curator: "Куратор Ч",
      room: "202",
    });
    const active = await listActiveScheduleEntries(env);
    const found = active.find((e) => e.name === "Четверг" && e.classHour === 16);
    expect(found).toBeDefined();
    expect(found!.curator).toBe("Куратор Ч");

    await deleteScheduleEntry(env, id); // cleanup, doesn't affect other tests' fixed dates
  });

  it("deleteScheduleEntry removes the row and reports success", async () => {
    const id = await addScheduleEntry(env, {
      name: "Воскресенье",
      weekday: 6,
      classHour: 18,
      classMinute: 0,
      opensHour: 17,
      opensMinute: 0,
    });
    const deleted = await deleteScheduleEntry(env, id);
    expect(deleted).toBe(true);
    expect(await getScheduleEntry(env, id)).toBeNull();
  });

  it("deleteScheduleEntry on a nonexistent id is a safe no-op returning false", async () => {
    expect(await deleteScheduleEntry(env, 999_999_999)).toBe(false);
  });

  it("a deactivated (but not deleted) entry is excluded from listActiveScheduleEntries", async () => {
    const id = await addScheduleEntry(env, {
      name: "Тест-пауза",
      weekday: 0,
      classHour: 8,
      classMinute: 0,
      opensHour: 7,
      opensMinute: 0,
    });
    await env.DB.prepare("UPDATE weekly_schedule SET active = 0 WHERE id = ?").bind(id).run();

    const active = await listActiveScheduleEntries(env);
    expect(active.some((e) => e.name === "Тест-пауза")).toBe(false);

    const all = await listAllScheduleEntries(env);
    expect(all.some((e) => e.id === id)).toBe(true); // still visible in the full list
  });
});
