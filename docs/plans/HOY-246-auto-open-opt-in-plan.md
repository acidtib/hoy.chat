# HOY-246: auto-open spawned subagents opt-in (default off), design + SDD plan

Ticket: https://linear.app/hoychat/issue/HOY-246/auto-open-spawned-subagents-make-it-an-opt-in-setting-default-off

## Design

Small, fully scoped change; no separate design doc needed beyond this note.

HOY-236 auto-opens every spawned child thread as a panel (`store.ts:897`,
`get().openThread(childId)` inside `spawnChildThread`). At scale (many
agents, and now that HOY-245 lifts the recursion cap) that is a panel-per-
subagent storm. HOY-235 (shipped) gives FleetView as the replacement watch
surface, so the auto-open call becomes opt-in, default OFF.

- New pref `autoOpenSpawnedThreads: boolean`, default `false`, in
  `apps/desktop/src/state/prefs.ts`'s `AppPrefs`, alongside the existing
  four fields. Same pattern throughout: interface field, `PREFS_DEFAULTS`,
  `partialize`.
- Gate the call at `store.ts:897` behind it:
  `if (usePrefsStore.getState().autoOpenSpawnedThreads) get().openThread(childId);`
  `usePrefsStore` is already imported in `store.ts` (used identically for
  `confirmCloseStreaming` at `store.ts:594`), so this is a one-line, already-
  precedented change. Nothing else in `spawnChildThread` changes: the child
  is still inserted into `projects` and its transcript seeded regardless
  (that is what makes it visible in the sidebar and FleetView even when its
  panel never opens), only the panel-opening side effect is gated.
- Settings UI: a `ToggleRow` in `WorkspacePanel`
  (`apps/desktop/src/components/settings/panels.tsx`), the same panel that
  already hosts `confirmCloseStreaming` (the ticket's own named precedent) --
  panel-lifecycle behavior belongs together. Label "Auto-open spawned
  subagent threads", description makes the FleetView alternative explicit
  so the off-by-default choice reads as intentional, not missing.
- Teal `--agent` identity (HOY-236) and auto-close on delivery (HOY-240) are
  unrelated to panel-opening and stay untouched.
- No new store action, no new IPC. `usePrefsStore`'s existing `setPref` is
  the only write path, exactly like every other pref.

## Task 1: pref + gate

**Files**: `apps/desktop/src/state/prefs.ts`, `apps/desktop/src/state/store.ts`.

1. In `prefs.ts`: add `autoOpenSpawnedThreads: boolean;` to the `AppPrefs`
   interface (after `defaultProjectDir`, matching declaration order), add
   `autoOpenSpawnedThreads: false` to `PREFS_DEFAULTS`, add
   `autoOpenSpawnedThreads: s.autoOpenSpawnedThreads` to the `partialize`
   object. Three additions, same shape as the four existing fields; do not
   restructure anything else in the file.
2. In `store.ts`: at line ~897 (`get().openThread(childId);` inside
   `spawnChildThread`, right after the comment block that already
   anticipates this ticket), wrap it:
   `if (usePrefsStore.getState().autoOpenSpawnedThreads) get().openThread(childId);`
   Update the preceding comment: it currently says "HOY-246 will gate this
   so a queued child does not steal focus; left as-is for now" -- replace
   with a comment reflecting the gate now exists, referencing the pref name.
   Do not touch anything else in `spawnChildThread` (the child is still
   inserted into `projects`/`turns`/`outstandingChildren` unconditionally
   above this line -- that is what keeps it visible in the sidebar and
   FleetView regardless of the pref).

**Verification**: `bun run check:ts`. No test file needed (a one-line
conditional wrapping an existing, already-tested call; `prefs.ts` has no
existing test file to extend, matching precedent).

## Task 2: settings UI toggle

**Files**: `apps/desktop/src/components/settings/panels.tsx`.

In `WorkspacePanel`: add `const autoOpenSpawnedThreads = usePrefsStore((s) =>
s.autoOpenSpawnedThreads);` alongside the panel's other `usePrefsStore`
reads, and a new `ToggleRow` in the same `Section` as
`confirmCloseStreaming` (immediately after it, another `<Separator />`
between them, same pattern as the existing two rows in that Section).
Label: "Auto-open spawned subagent threads". Description: "Open a panel for
each subagent a thread spawns. Off by default -- watch spawned agents in
FleetView instead (the sidebar's Fleet toggle)." `checked=
{autoOpenSpawnedThreads}`, `onChange={(v) =>
setPref("autoOpenSpawnedThreads", v)}`, matching the existing rows'
call shape exactly.

**Verification**: `bun run check:ts`, then manual: open Settings ->
Workspace, confirm the new toggle renders under "Confirm before closing a
streaming panel" with the FleetView-referencing description, toggle it on,
spawn a subagent, confirm its panel now opens automatically; toggle it back
off, spawn another, confirm no panel opens but the child still appears in
the sidebar (nested) and in FleetView.

## Whole-branch check (small enough to do inline, no separate review agent)

- `git diff main..HEAD` reviewed directly: confirm the gate is a pure
  conditional wrap (no other `spawnChildThread` behavior changed), the pref
  follows the exact existing four-field pattern, and the toggle is wired to
  the same `usePrefsStore`/`setPref` path every other toggle in this file
  uses.
- No new backend/IPC, no emojis/em-dashes, `HOY-246:`-prefixed commits, no
  Co-Authored-By.
