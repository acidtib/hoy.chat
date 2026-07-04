import { test, expect } from "bun:test";
import type { UsageDay } from "./types";
import {
  daysInRange,
  totals,
  streaks,
  peakHour,
  modelRanking,
  dateKey,
  trendDays,
} from "./usage";

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

test("trendDays fills gaps as a continuous window", () => {
  const days = [day("2026-07-04", 10), day("2026-07-08", 20), day("2026-07-10", 30)];
  const seven = trendDays(days, "7d", today);
  expect(seven.length).toBe(7); // 07-04 .. 07-10, inclusive
  expect(seven[0].date).toBe("2026-07-04");
  expect(seven[6].date).toBe("2026-07-10");
  // A gap day is zero-filled, a present day keeps its tokens.
  const gap = seven.find((d) => d.date === "2026-07-05");
  expect(gap?.tokens.total).toBe(0);
  expect(seven.find((d) => d.date === "2026-07-08")?.tokens.total).toBe(20);
});

test("trendDays 'all' spans the first active day through today", () => {
  const days = [day("2026-07-06", 5), day("2026-07-10", 5)];
  const all = trendDays(days, "all", today);
  expect(all[0].date).toBe("2026-07-06");
  expect(all[all.length - 1].date).toBe("2026-07-10");
  expect(all.length).toBe(5); // 07-06 .. 07-10
});

test("dateKey is local YYYY-MM-DD", () => {
  expect(dateKey(new Date("2026-07-03T23:30:00"))).toBe("2026-07-03");
});
