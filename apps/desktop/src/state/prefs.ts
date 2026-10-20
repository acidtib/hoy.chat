// Renderer-owned UI preferences. These are NOT Pi settings (Pi owns model,
// thinking level, permission mode, auto-compaction per session). They are local
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
import { MAX_CONCURRENT_AGENTS } from "./limits";
import type { ModelRef } from "@/lib/types";

export type AppTheme = "light" | "dark" | "system";

export interface AppPrefs {
  // Applied to <html>. "system" follows prefers-color-scheme.
  theme: AppTheme;
  // First-run setup gate. Provider credentials still live in Pi's auth.json
  // this only records that the local UI flow has been completed.
  onboardingCompleted: boolean;
  // Composer: Enter sends. When false, Enter inserts a newline and Cmd/Ctrl+Enter
  // sends. (Shift+Enter mid-turn still queues a follow-up regardless.)
  sendOnEnter: boolean;
  // Reasoning shows in full in the timeline. When off it collapses to a live
  // preview of its last lines that the user can click open.
  showReasoning: boolean;
  // Edit, write and patch tool parts start expanded. When off they collapse to
  // a preview of the diff's last lines.
  expandEditTools: boolean;
  // Shell tool parts start expanded. When off they collapse to a preview of the
  // output's last lines. Approval-pending and errored tools stay open regardless.
  expandShellTools: boolean;
  // Confirm before closing a panel whose response is still streaming.
  confirmCloseStreaming: boolean;
  // Starting directory for the "Open project" picker. Empty = OS default.
  defaultProjectDir: string;
  // Open a panel for each subagent a thread spawns. Off by default. Fleet
  // is the intended way to watch spawned agents instead.
  autoOpenSpawnedThreads: boolean;
  // Prompt for consent before a thread spawns each subagent type. Off by
  // default (HOY-248): spawns proceed without a gate and the user watches or
  // intervenes via Fleet. On restores the per-type "Allow / Allow for this
  // session / Deny" prompt. Threaded to the sidecar as HOY_REQUIRE_SUBAGENT_APPROVAL.
  requireSubagentApproval: boolean;
  // How many spawned subagent initial runs can stream at once. The rest queue
  // FIFO (HOY-247). Clamped to at least 1 at the call site. The depth cap stays
  // a hard constant, not a pref, so the fork-bomb guard cannot be tuned away.
  maxConcurrentAgents: number;
  // Keep the machine awake while any thread is mid-turn (HOY-188), so a long
  // unattended run does not idle-sleep out from under the user. On by default.
  // Synced to the Rust keep-awake owner thread via the set_keep_awake command
  // when off, the wake lock is never taken and the machine can idle-sleep.
  keepAwakeWhileStreaming: boolean;
  // Global default for Pi's auto-compaction (HOY-275): when a thread's context
  // approaches the window, Pi summarizes older turns instead of overflowing. On
  // by default, matching Pi's own default. Unlike other Pi settings this one is
  // a renderer-authoritative default (Pi persists it globally, but that is
  // unreachable with no session open), applied to every session on spawn via
  // set_auto_compaction and pushed to the active session when toggled.
  autoCompaction: boolean;
  // Name new threads from their first message with a cheap model (HOY-370).
  // Off keeps the first line of the message as the title.
  autoTitles: boolean;
  // Sidebar collapsed state. Defaults to false (open) so the sidebar
  // naturally appears when chrome first renders. Persisted so the user's
  // manual collapse survives restarts.
  sidebarCollapsed: boolean;
  // The model new threads start on. Null falls back to Pi's last pick.
  preferredModel: ModelRef | null;
  // Models hidden from the pickers, as modelKey() strings. New models start on.
  disabledModels: string[];
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
  theme: "system",
  onboardingCompleted: false,
  sendOnEnter: true,
  showReasoning: false,
  expandEditTools: false,
  expandShellTools: true,
  confirmCloseStreaming: true,
  defaultProjectDir: "",
  autoOpenSpawnedThreads: false,
  requireSubagentApproval: false,
  maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
  keepAwakeWhileStreaming: true,
  autoCompaction: true,
  sidebarCollapsed: false,
  autoTitles: true,
  preferredModel: null,
  disabledModels: [],
};

// v1 split expandReasoning / expandToolDetails into the timeline part prefs.
export function migratePrefs(persisted: unknown, version: number): Partial<AppPrefs> {
  const p = { ...(persisted as Record<string, unknown>) };
  if (version < 1) {
    if (typeof p.expandReasoning === "boolean") p.showReasoning = p.expandReasoning;
    if (typeof p.expandToolDetails === "boolean") p.expandEditTools = p.expandToolDetails;
    delete p.expandReasoning;
    delete p.expandToolDetails;
  }
  return p as Partial<AppPrefs>;
}

export const usePrefsStore = create<PrefsStore>()(
  persist(
    (set) => ({
      ...PREFS_DEFAULTS,
      setPref: (key, value) => set({ [key]: value } as Partial<AppPrefs>),
      reset: () => set({ ...PREFS_DEFAULTS }),
    }),
    {
      name: "hoy.prefs",
      version: 1,
      migrate: (persisted, version) => migratePrefs(persisted, version) as PrefsStore,
      // Falls back to an in-memory no-op when localStorage is absent (test/SSR),
      // so persistence works in the webview without warning noise elsewhere.
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : memoryStorage,
      ),
      // Data fields only. Actions are recreated on hydrate. New fields fall back
      // to their default because persist merges the stored partial over initial
      // state.
      partialize: (s) => ({
        theme: s.theme,
        onboardingCompleted: s.onboardingCompleted,
        sendOnEnter: s.sendOnEnter,
        showReasoning: s.showReasoning,
        expandEditTools: s.expandEditTools,
        expandShellTools: s.expandShellTools,
        confirmCloseStreaming: s.confirmCloseStreaming,
        defaultProjectDir: s.defaultProjectDir,
        autoOpenSpawnedThreads: s.autoOpenSpawnedThreads,
        requireSubagentApproval: s.requireSubagentApproval,
        maxConcurrentAgents: s.maxConcurrentAgents,
        keepAwakeWhileStreaming: s.keepAwakeWhileStreaming,
        autoCompaction: s.autoCompaction,
        sidebarCollapsed: s.sidebarCollapsed,
        autoTitles: s.autoTitles,
        preferredModel: s.preferredModel,
        disabledModels: s.disabledModels,
      }),
    },
  ),
);
