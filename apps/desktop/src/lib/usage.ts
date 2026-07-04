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

function emptyDay(date: string): UsageDay {
  return {
    date,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    messages: 0,
    sessions: 0,
    byModel: {},
    byHour: new Array(24).fill(0),
  };
}

// A continuous, gap-filled day series for the trend chart: every calendar day
// in the window, with real data where present and a zero day otherwise. "7d"/
// "30d" are the trailing window ending today; "all" spans the first active day
// through today. Keeps the x-axis time-accurate instead of collapsing gaps.
export function trendDays(
  days: UsageDay[],
  range: UsageRange,
  today: Date = new Date(),
): UsageDay[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = new Date(today);
  let start: Date;
  if (range === "7d") {
    start = new Date(today);
    start.setDate(start.getDate() - 6);
  } else if (range === "30d") {
    start = new Date(today);
    start.setDate(start.getDate() - 29);
  } else {
    const first = days[0]?.date;
    start = first ? new Date(`${first}T00:00:00`) : new Date(today);
  }
  const out: UsageDay[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dateKey(cursor);
    out.push(byDate.get(key) ?? emptyDay(key));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export interface UsageTotals {
  tokens: number;
  cost: number;
  messages: number;
  activeDays: number;
  sessions: number;
}
export function totals(days: UsageDay[]): UsageTotals {
  let tokens = 0;
  let cost = 0;
  let messages = 0;
  let sessions = 0;
  for (const d of days) {
    tokens += d.tokens.total;
    cost += d.cost;
    messages += d.messages;
    sessions += d.sessions;
  }
  return { tokens, cost, messages, activeDays: days.length, sessions };
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

// Stable, distinct colors for the model charts (trend stacks, donut, legend,
// ranking). Assigned by descending token rank; models past the palette fold
// into "Other models" with the last color.
export const MODEL_PALETTE = [
  "#4c9dff", // blue
  "#3ecf8e", // green
  "#8b7cf6", // purple
  "#ff6b6b", // red
  "#ffa94d", // orange
  "#38d9c9", // teal (also "Other models")
];
const OTHER_COLOR = MODEL_PALETTE[MODEL_PALETTE.length - 1];
const OTHER_LABEL = "Other models";

export interface RankedModel {
  model: string;
  tokens: number;
  share: number;
  color: string;
}

// One day's stacked segments in ranked order (top models, then "Other").
export interface DaySegment {
  model: string;
  color: string;
  tokens: number;
}

export interface ModelBreakdown {
  ranked: RankedModel[]; // top models + a folded "Other models" row
  total: number;
  daySegments: (day: UsageDay) => DaySegment[];
}

// Rank models by tokens across `days`, keep the top `topN` with palette colors,
// fold the rest into "Other models". Returns the ranking plus a per-day
// stacked-segment builder that reuses the same colors.
export function modelBreakdown(days: UsageDay[], topN = 5): ModelBreakdown {
  const base = modelRanking(days);
  const top = base.slice(0, topN);
  const topNames = new Set(top.map((r) => r.model));
  const colorByName = new Map(top.map((r, i) => [r.model, MODEL_PALETTE[i]]));
  const hasOther = base.length > top.length;

  const ranked: RankedModel[] = top.map((r, i) => ({
    ...r,
    color: MODEL_PALETTE[i],
  }));
  if (hasOther) {
    const rest = base.slice(topN);
    ranked.push({
      model: OTHER_LABEL,
      tokens: rest.reduce((a, b) => a + b.tokens, 0),
      share: rest.reduce((a, b) => a + b.share, 0),
      color: OTHER_COLOR,
    });
  }

  const total = base.reduce((a, b) => a + b.tokens, 0);

  const daySegments = (day: UsageDay): DaySegment[] => {
    const segs: DaySegment[] = top.map((r) => ({
      model: r.model,
      color: colorByName.get(r.model) ?? OTHER_COLOR,
      tokens: day.byModel[r.model] ?? 0,
    }));
    if (hasOther) {
      let other = 0;
      for (const [m, t] of Object.entries(day.byModel)) {
        if (!topNames.has(m)) other += t;
      }
      segs.push({ model: OTHER_LABEL, color: OTHER_COLOR, tokens: other });
    }
    return segs;
  };

  return { ranked, total, daySegments };
}
