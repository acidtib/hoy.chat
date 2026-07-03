// Renderer-owned UI preferences. These are NOT Pi settings (Pi owns model,
// thinking level, permission mode, auto-compaction per session); they are local
// app behavior the user controls. Kept in a dedicated store, separate from the
// session store, so the delicate workspace autosave is untouched. Persisted to
// localStorage via zustand's persist middleware, which the Tauri webview scopes
// per app identifier (dev's chat.hoy.desktop.dev has its own storage, so dev
// prefs never leak into production).
//
// Rule of the settings work: every pref here must actually change behavior at a
// wired call site. A toggle that persists but does nothing is a fake control and
// does not belong in this store.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface AppPrefs {
  // Composer: Enter sends. When false, Enter inserts a newline and Cmd/Ctrl+Enter
  // sends. (Shift+Enter mid-turn still queues a follow-up regardless.)
  sendOnEnter: boolean;
  // Reasoning blocks in the transcript start expanded instead of collapsed.
  expandReasoning: boolean;
  // Confirm before closing a panel whose response is still streaming.
  confirmCloseStreaming: boolean;
  // Starting directory for the "Open project" picker. Empty = OS default.
  defaultProjectDir: string;
  // Open a panel for each subagent a thread spawns. Off by default; FleetView
  // is the intended way to watch spawned agents instead.
  autoOpenSpawnedThreads: boolean;
  // Prompt for consent before a thread spawns each subagent type. Off by
  // default (HOY-248): spawns proceed without a gate and the user watches or
  // intervenes via FleetView. On restores the per-type "Allow / Allow for this
  // session / Deny" prompt. Threaded to the sidecar as HOY_REQUIRE_SUBAGENT_APPROVAL.
  requireSubagentApproval: boolean;
}

interface PrefsStore extends AppPrefs {
  setPref: <K extends keyof AppPrefs>(key: K, value: AppPrefs[K]) => void;
  reset: () => void;
}

const memoryStore = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStore.set(k, v),
  removeItem: (k: string) => void memoryStore.delete(k),
};

export const PREFS_DEFAULTS: AppPrefs = {
  sendOnEnter: true,
  expandReasoning: false,
  confirmCloseStreaming: true,
  defaultProjectDir: "",
  autoOpenSpawnedThreads: false,
  requireSubagentApproval: false,
};

export const usePrefsStore = create<PrefsStore>()(
  persist(
    (set) => ({
      ...PREFS_DEFAULTS,
      setPref: (key, value) => set({ [key]: value } as Partial<AppPrefs>),
      reset: () => set({ ...PREFS_DEFAULTS }),
    }),
    {
      name: "hoy.prefs",
      // Falls back to an in-memory no-op when localStorage is absent (test/SSR),
      // so persistence works in the webview without warning noise elsewhere.
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : memoryStorage,
      ),
      // Data fields only; actions are recreated on hydrate. New fields fall back
      // to their default because persist merges the stored partial over initial
      // state.
      partialize: (s) => ({
        sendOnEnter: s.sendOnEnter,
        expandReasoning: s.expandReasoning,
        confirmCloseStreaming: s.confirmCloseStreaming,
        defaultProjectDir: s.defaultProjectDir,
        autoOpenSpawnedThreads: s.autoOpenSpawnedThreads,
        requireSubagentApproval: s.requireSubagentApproval,
      }),
    },
  ),
);
