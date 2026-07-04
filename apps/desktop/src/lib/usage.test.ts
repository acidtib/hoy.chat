import { test, expect } from "bun:test";
import type { UsageDay } from "./types";
import { daysInRange, totals, streaks, peakHour, modelRanking, dateKey } from "./usage";

function day(
  date: string,
  total: number,
  byModel: Record<string, number> = {},
  byHour?: number[],
  sessions = 1,
): UsageDay {
  return {
    date,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    cost: 0,
    messages: 1,
    sessions,
    byModel,
    byHour: byHour ?? new Array(24).fill(0),
  };
}

const today = new Date("2026-07-10T12:00:00");

test("daysInRange filters by trailing window", () => {
  const days = [day("2026-06-01", 1), day("2026-07-05", 1), day("2026-07-10", 1)];
  expect(daysInRange(days, "all", today).length).toBe(3);
  expect(daysInRange(days, "7d", today).map((d) => d.date)).toEqual(["2026-07-05", "2026-07-10"]);
  expect(daysInRange(days, "30d", today).length).toBe(2);
});

test("totals sums tokens/messages/sessions and counts active days", () => {
  const t = totals([
    day("2026-07-01", 100, {}, undefined, 2),
    day("2026-07-02", 40, {}, undefined, 1),
  ]);
  expect(t.tokens).toBe(140);
  expect(t.messages).toBe(2);
  expect(t.activeDays).toBe(2);
  expect(t.sessions).toBe(3); // 2 + 1, range-scoped
});

test("streaks: current counts back from today, longest finds the longest run", () => {
  const days = [
    day("2026-07-01", 1),
    day("2026-07-02", 1),
    day("2026-07-03", 1),
    day("2026-07-09", 1),
    day("2026-07-10", 1),
  ];
  const s = streaks(days, today);
  expect(s.current).toBe(2); // 07-09, 07-10
  expect(s.longest).toBe(3); // 07-01..07-03
});

test("streaks: current tolerates today having no activity yet", () => {
  const days = [day("2026-07-08", 1), day("2026-07-09", 1)];
  expect(streaks(days, today).current).toBe(2); // today 07-10 empty, streak ends yesterday
});

test("peakHour returns the busiest local hour or null", () => {
  const hours = new Array(24).fill(0);
  hours[21] = 500;
  expect(peakHour([day("2026-07-10", 500, {}, hours)])).toBe(21);
  expect(peakHour([day("2026-07-10", 0)])).toBeNull();
});

test("modelRanking ranks by tokens with shares", () => {
  const rows = modelRanking([day("2026-07-10", 100, { opus: 75, deepseek: 25 })]);
  expect(rows[0].model).toBe("opus");
  expect(rows[0].share).toBeCloseTo(0.75, 5);
  expect(rows[1].model).toBe("deepseek");
});

test("dateKey is local YYYY-MM-DD", () => {
  expect(dateKey(new Date("2026-07-03T23:30:00"))).toBe("2026-07-03");
});
