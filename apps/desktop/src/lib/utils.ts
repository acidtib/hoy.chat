import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Short, prefixed random id. Uses crypto.randomUUID when available and falls
// back to Math.random for environments without it (older webviews). Shared by
// the store (thread/project ids) and image attachments so the two id schemes
// cannot drift apart.
export function shortId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Compact relative time for sidebar thread rows: "now", "5m", "3h", "2d", "3w".
export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

// Compact token counts for the one-line context bar: 1234 -> 1.2k, 200000 -> 200k.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

// Formats a millisecond duration as elapsed time, e.g. "3m 12s". Shared by the
// store's /goal status notice and GoalCard's live-ticking elapsed display, so
// the two surfaces cannot drift apart.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

export type RecencyBucket = "Today" | "Yesterday" | "This Week" | "Older";

// Bucket an epoch-ms timestamp by recency for the Zed-style history view. Uses
// calendar-day boundaries: Today, Yesterday, earlier this 7-day window, then Older.
export function bucketByRecency(epochMs: number, now = Date.now()): RecencyBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = startOfToday.getTime();
  if (epochMs >= todayStart) return "Today";
  if (epochMs >= todayStart - dayMs) return "Yesterday";
  if (epochMs >= todayStart - 6 * dayMs) return "This Week";
  return "Older";
}

// Display order of the recency buckets, most recent first.
export const RECENCY_ORDER: RecencyBucket[] = [
  "Today",
  "Yesterday",
  "This Week",
  "Older",
];
