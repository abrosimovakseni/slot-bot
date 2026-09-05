import { describe, expect, it } from "vitest";
import { WEEKLY_SCHEDULE } from "../src/config";
import {
  allWeekOccurrences,
  formatMoscowDateTime,
  formatTimeOfDay,
  moscowDateKey,
  moscowWeekday,
  openTimeOneHourBefore,
  parseMoscowDateTime,
  parseTimeOfDay,
  weekOccurrence,
} from "../src/timeUtils";

const WED = WEEKLY_SCHEDULE.find((e) => e.name === "Среда")!;
const FRI = WEEKLY_SCHEDULE.find((e) => e.name === "Пятница")!;
const SAT = WEEKLY_SCHEDULE.find((e) => e.name === "Суббота")!;

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

  it("TEST20: Saturday occurrence is 10:30 class / 09:30 open, Europe/Moscow, with its own curator/room", () => {
    const now = new Date("2026-09-12T09:00:00.000Z"); // Saturday
    const { scheduledAt, opensAt } = weekOccurrence(now, SAT);
    expect(scheduledAt.toISOString()).toBe("2026-09-12T07:30:00.000Z"); // 10:30 MSK
    expect(opensAt.toISOString()).toBe("2026-09-12T06:30:00.000Z"); // 09:30 MSK
    expect(moscowWeekday(scheduledAt)).toBe(5);
    expect(SAT.curator).toBe("Боремир Иванович");
    expect(SAT.room).toBe("324");
  });

  it("allWeekOccurrences returns all schedule entries passed to it for the containing week", () => {
    const now = new Date("2026-09-09T09:00:00.000Z");
    const occurrences = allWeekOccurrences(now, WEEKLY_SCHEDULE);
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => o.entry.name).sort()).toEqual(["Пятница", "Среда", "Суббота"]);
  });

  it("allWeekOccurrences returns nothing for an empty entries array", () => {
    expect(allWeekOccurrences(new Date("2026-09-09T09:00:00.000Z"), [])).toEqual([]);
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

describe("formatMoscowDateTime / parseMoscowDateTime (admin one-off consultations)", () => {
  it("formats a UTC instant as its Moscow wall-clock DD.MM.YYYY HH:MM", () => {
    expect(formatMoscowDateTime(new Date("2026-09-20T12:00:00.000Z"))).toBe("20.09.2026 15:00");
  });

  it("parses DD.MM.YYYY HH:MM as Moscow local time back into the same UTC instant", () => {
    expect(parseMoscowDateTime("20.09.2026 15:00")?.toISOString()).toBe("2026-09-20T12:00:00.000Z");
  });

  it("round-trips through both directions for an arbitrary instant", () => {
    const original = new Date("2027-01-06T06:30:00.000Z");
    const label = formatMoscowDateTime(original);
    expect(parseMoscowDateTime(label)?.toISOString()).toBe(original.toISOString());
  });

  it("accepts a single-digit day/month/hour", () => {
    expect(parseMoscowDateTime("5.9.2026 9:05")?.toISOString()).toBe("2026-09-05T06:05:00.000Z");
  });

  it("rejects text that doesn't match the format", () => {
    expect(parseMoscowDateTime("not a date")).toBeNull();
    expect(parseMoscowDateTime("20/09/2026 15:00")).toBeNull();
    expect(parseMoscowDateTime("20.09.2026")).toBeNull();
  });

  it("rejects an impossible calendar date instead of silently rolling it over", () => {
    expect(parseMoscowDateTime("31.02.2026 12:00")).toBeNull(); // February never has 31 days
    expect(parseMoscowDateTime("31.04.2026 12:00")).toBeNull(); // April has 30 days
  });

  it("rejects an out-of-range hour or minute", () => {
    expect(parseMoscowDateTime("20.09.2026 25:00")).toBeNull();
    expect(parseMoscowDateTime("20.09.2026 12:60")).toBeNull();
  });
});

describe("parseTimeOfDay / formatTimeOfDay / openTimeOneHourBefore (admin weekly schedule)", () => {
  it("parses a well-formed ЧЧ:ММ", () => {
    expect(parseTimeOfDay("10:30")).toEqual({ hour: 10, minute: 30 });
    expect(parseTimeOfDay("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects text that doesn't match, or an impossible hour/minute", () => {
    expect(parseTimeOfDay("not a time")).toBeNull();
    expect(parseTimeOfDay("10.30")).toBeNull();
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("10:60")).toBeNull();
  });

  it("formatTimeOfDay round-trips a parsed value back to ЧЧ:ММ, zero-padded", () => {
    expect(formatTimeOfDay({ hour: 9, minute: 5 })).toBe("09:05");
    expect(formatTimeOfDay(parseTimeOfDay("10:30")!)).toBe("10:30");
  });

  it("openTimeOneHourBefore subtracts 60 minutes, same day", () => {
    expect(openTimeOneHourBefore({ hour: 10, minute: 30 })).toEqual({ hour: 9, minute: 30 });
    expect(openTimeOneHourBefore({ hour: 1, minute: 0 })).toEqual({ hour: 0, minute: 0 });
  });

  it("openTimeOneHourBefore clamps at 00:00 rather than rolling into the previous day", () => {
    expect(openTimeOneHourBefore({ hour: 0, minute: 30 })).toEqual({ hour: 0, minute: 0 });
    expect(openTimeOneHourBefore({ hour: 0, minute: 0 })).toEqual({ hour: 0, minute: 0 });
  });
});
