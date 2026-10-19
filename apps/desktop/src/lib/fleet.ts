// Pure queue and estimate helpers for the Fleet (HOY-350). Estimates come only
// from this agent's own finished runs; they are shown, never enforced.

import type { FleetRun, QueuedIssue, Thread } from "./types";

export const DEFAULT_RUN_MINUTES = 15;

type Run = FleetRun & { endedAt: number };

// Threads delegated to an agent, live (not archived).
function delegated(threads: Thread[], agent: string): Thread[] {
  return threads.filter((t) => !t.archived && t.agent === agent && t.fleetRun);
}

export function openRuns(threads: Thread[], agent: string): Thread[] {
  return delegated(threads, agent).filter((t) => t.fleetRun!.endedAt == null);
}

// Runs that finished cleanly, the only ones estimates learn from. Archived
// threads still count: archiving releases the issue, not the history.
export function finishedRuns(threads: Thread[], agent: string): Run[] {
  return threads
    .filter((t) => t.agent === agent && t.fleetRun?.outcome === "done")
    .map((t) => t.fleetRun as Run)
    .filter((r) => r.endedAt != null && r.endedAt > r.startedAt);
}

// The agent's latest unacknowledged run that did not end cleanly. While one
// exists the agent's queue does not advance.
export function haltingThread(threads: Thread[], agent: string): Thread | null {
  let latest: Thread | null = null;
  for (const t of delegated(threads, agent)) {
    const r = t.fleetRun!;
    if (r.endedAt == null) continue;
    if (!latest || r.endedAt > latest.fleetRun!.endedAt!) latest = t;
  }
  const r = latest?.fleetRun;
  return r && r.outcome !== "done" && !r.acknowledged ? latest : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const minutesOf = (r: Run) => (r.endedAt - r.startedAt) / 60_000;

// Minutes an issue should take: per-point pace times its estimate when both are
// known, else the median run, else a flat default.
export function estimateMinutes(history: Run[], points?: number | null): number {
  if (history.length === 0) return DEFAULT_RUN_MINUTES;
  const pointed = history.filter((r) => (r.estimate ?? 0) > 0);
  if (points && points > 0 && pointed.length > 0) {
    return median(pointed.map((r) => minutesOf(r) / r.estimate!)) * points;
  }
  return median(history.map(minutesOf));
}

export function costPerMinute(history: Run[]): number | null {
  const priced = history.filter((r) => r.cost != null);
  const minutes = priced.reduce((n, r) => n + minutesOf(r), 0);
  if (priced.length === 0 || minutes <= 0) return null;
  return priced.reduce((n, r) => n + r.cost!, 0) / minutes;
}

export interface AgentForecast {
  // Epoch ms when the agent's running and queued work should be done.
  busyUntil: number | null;
  // Minutes of work left, running remainder plus everything queued.
  minutesLeft: number;
}

// Lay queued work onto the agent's slots after what is running now.
export function forecast(
  now: number,
  running: { startedAt: number; minutes: number }[],
  queued: number[],
  concurrency: number,
): AgentForecast {
  const slots = running.map((r) =>
    Math.max(r.minutes - (now - r.startedAt) / 60_000, 1),
  );
  while (slots.length < Math.max(1, concurrency)) slots.push(0);
  for (const m of queued) {
    const i = slots.indexOf(Math.min(...slots));
    slots[i] += m;
  }
  const left =
    running.reduce(
      (n, r) => n + Math.max(r.minutes - (now - r.startedAt) / 60_000, 1),
      0,
    ) + queued.reduce((n, m) => n + m, 0);
  const end = Math.max(...slots);
  return {
    busyUntil: running.length + queued.length > 0 ? now + end * 60_000 : null,
    minutesLeft: left,
  };
}

export function queueOf(queue: QueuedIssue[], agent: string): QueuedIssue[] {
  return queue.filter((q) => q.agent === agent);
}

// Move one queued issue a step within its agent's queue, leaving every other
// agent's items where they are.
export function moveQueued(
  queue: QueuedIssue[],
  issueId: string,
  delta: -1 | 1,
): QueuedIssue[] {
  const from = queue.findIndex((q) => q.issue.id === issueId);
  if (from < 0) return queue;
  const agent = queue[from].agent;
  let to = from + delta;
  while (to >= 0 && to < queue.length && queue[to].agent !== agent) to += delta;
  if (to < 0 || to >= queue.length) return queue;
  const next = [...queue];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function formatMinutes(m: number): string {
  const r = Math.max(1, Math.round(m));
  return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h${r % 60 ? ` ${r % 60}m` : ""}`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatCost(usd: number): string {
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}
