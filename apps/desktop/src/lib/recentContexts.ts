// Recently used @ context refs for the picker's Recent section (HOY-220),
// persisted in localStorage and keyed by project path so a file from one project
// never shows in another. Kept small; most-recent first.

import { contextKey } from "./types";
import type { ContextRef } from "./types";

const KEY = "hoy.recentContexts.v1";
const MAX = 6;

type Store = Record<string, ContextRef[]>;

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function getRecentContexts(
  projectPath: string | null | undefined,
): ContextRef[] {
  if (!projectPath) return [];
  return load()[projectPath] ?? [];
}

export function addRecentContext(
  projectPath: string | null | undefined,
  ref: ContextRef,
): void {
  if (!projectPath) return;
  const store = load();
  const key = contextKey(ref);
  const next = [ref, ...(store[projectPath] ?? []).filter((r) => contextKey(r) !== key)];
  store[projectPath] = next.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore quota/availability errors; recents are best-effort.
  }
}
