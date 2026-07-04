import type { UsageDay } from "./types";

export type UsageRange = "all" | "30d" | "7d";

// Local YYYY-MM-DD for a Date, matching the keys the Rust side emits.
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Trailing-window filter. "all" returns every day; "7d"/"30d" keep days whose
// key is on or after the window's first day (inclusive of today).
export function daysInRange(
  days: UsageDay[],
  range: UsageRange,
  today: Date = new Date(),
): UsageDay[] {
  if (range === "all") return days;
  const span = range === "7d" ? 7 : 30;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (span - 1));
  const cutoffKey = dateKey(cutoff);
  return days.filter((d) => d.date >= cutoffKey);
}

export interface UsageTotals {
  tokens: number;
  cost: number;
  messages: number;
  activeDays: number;
  sessions: number;
}
export function totals(days: UsageDay[], sessionCount: number): UsageTotals {
  let tokens = 0;
  let cost = 0;
  let messages = 0;
  for (const d of days) {
    tokens += d.tokens.total;
    cost += d.cost;
    messages += d.messages;
  }
  return { tokens, cost, messages, activeDays: days.length, sessions: sessionCount };
}

export interface Streaks {
  current: number;
  longest: number;
}
export function streaks(days: UsageDay[], today: Date = new Date()): Streaks {
  const set = new Set(days.map((d) => d.date));
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of sorted) {
    run = prev && isNextDay(prev, key) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = key;
  }
  let current = 0;
  const cursor = new Date(today);
  // Allow today to be empty (streak may end yesterday) before walking back.
  if (!set.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (set.has(dateKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

function isNextDay(a: string, b: string): boolean {
  const da = new Date(`${a}T00:00:00`);
  da.setDate(da.getDate() + 1);
  return dateKey(da) === b;
}

// Busiest local hour (0-23) by token total across the given days; null if idle.
export function peakHour(days: UsageDay[]): number | null {
  const buckets = new Array(24).fill(0);
  for (const d of days) for (let h = 0; h < 24; h++) buckets[h] += d.byHour[h] ?? 0;
  let best = -1;
  let bestVal = 0;
  for (let h = 0; h < 24; h++) {
    if (buckets[h] > bestVal) {
      bestVal = buckets[h];
      best = h;
    }
  }
  return best >= 0 ? best : null;
}

export interface ModelShare {
  model: string;
  tokens: number;
  share: number;
}
export function modelRanking(days: UsageDay[]): ModelShare[] {
  const byModel = new Map<string, number>();
  for (const d of days) {
    for (const [m, t] of Object.entries(d.byModel)) byModel.set(m, (byModel.get(m) ?? 0) + t);
  }
  const grand = [...byModel.values()].reduce((a, b) => a + b, 0);
  return [...byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens, share: grand > 0 ? tokens / grand : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}

export interface HeatDay {
  date: string;
  tokens: number;
}
// A weeks x 7 grid (rows Sunday..Saturday) ending at the week containing today.
// Each cell carries that day's total tokens (0 when absent).
export function heatmapGrid(
  days: UsageDay[],
  weeks: number,
  today: Date = new Date(),
): HeatDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d.tokens.total]));
  const lastSunday = new Date(today);
  lastSunday.setDate(lastSunday.getDate() - lastSunday.getDay());
  const cols: HeatDay[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col: HeatDay[] = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(lastSunday);
      d.setDate(d.getDate() - w * 7 + r);
      const key = dateKey(d);
      col.push({ date: key, tokens: byDate.get(key) ?? 0 });
    }
    cols.push(col);
  }
  return cols;
}
