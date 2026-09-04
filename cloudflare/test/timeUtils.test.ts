import { describe, expect, it } from "vitest";
import { WEEKLY_SCHEDULE } from "../src/config";
import { allWeekOccurrences, moscowDateKey, moscowWeekday, weekOccurrence } from "../src/timeUtils";

const WED = WEEKLY_SCHEDULE.find((e) => e.name === "Среда")!;
const FRI = WEEKLY_SCHEDULE.find((e) => e.name === "Пятница")!;

describe("timeUtils (pure)", () => {
  it("TEST18: Wednesday occurrence is 10:30 class / 09:30 open, Europe/Moscow", () => {
    // Wednesday 2026-09-09 12:00 MSK (09:00 UTC) as `now`.
    const now = new Date("2026-09-09T09:00:00.000Z");
    const { scheduledAt, opensAt } = weekOccurrence(now, WED);
    expect(scheduledAt.toISOString()).toBe("2026-09-09T07:30:00.000Z"); // 10:30 MSK
    expect(opensAt.toISOString()).toBe("2026-09-09T06:30:00.000Z"); // 09:30 MSK
    expect(moscowWeekday(scheduledAt)).toBe(2);
  });

  it("TEST19: Friday occurrence is 10:30 class / 09:30 open, Europe/Moscow", () => {
    const now = new Date("2026-09-11T09:00:00.000Z"); // Friday
    const { scheduledAt, opensAt } = weekOccurrence(now, FRI);
    expect(scheduledAt.toISOString()).toBe("2026-09-11T07:30:00.000Z");
    expect(opensAt.toISOString()).toBe("2026-09-11T06:30:00.000Z");
    expect(moscowWeekday(scheduledAt)).toBe(4);
  });

  it("Wednesday and Friday occurrences for the same `now` fall in the same ISO week, correctly ordered", () => {
    const now = new Date("2026-09-10T12:00:00.000Z"); // Thursday
    const wed = weekOccurrence(now, WED).scheduledAt;
    const fri = weekOccurrence(now, FRI).scheduledAt;
    expect(wed < fri).toBe(true);
    expect(fri.getTime() - wed.getTime()).toBe(2 * 86_400_000);
  });

  it("allWeekOccurrences returns both schedule entries for the containing week", () => {
    const now = new Date("2026-09-09T09:00:00.000Z");
    const occurrences = allWeekOccurrences(now);
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.entry.name).sort()).toEqual(["Пятница", "Среда"]);
  });

  it("moscowDateKey reflects the Moscow calendar date, not the UTC one, near midnight", () => {
    // 2026-09-09 23:30 MSK = 2026-09-09 20:30 UTC -- still Sept 9th in Moscow.
    expect(moscowDateKey(new Date("2026-09-09T20:30:00.000Z"))).toBe("2026-09-09");
    // 2026-09-10 00:30 MSK = 2026-09-09 21:30 UTC -- already Sept 10th in Moscow.
    expect(moscowDateKey(new Date("2026-09-09T21:30:00.000Z"))).toBe("2026-09-10");
  });

  it("moscowWeekday follows Python's Monday=0..Sunday=6 convention", () => {
    // 2026-09-07 is a Monday.
    expect(moscowWeekday(new Date("2026-09-07T10:00:00.000Z"))).toBe(0);
    // 2026-09-13 is a Sunday.
    expect(moscowWeekday(new Date("2026-09-13T10:00:00.000Z"))).toBe(6);
  });
});
