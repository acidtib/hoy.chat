# Thread Panel Full Screen + Persistent Drafts (HOY-181)

## Problem

Each thread header has a `Maximize2` button (top right, `src/components/ThreadView.tsx`) with `aria-label="Expand"` and no `onClick`. It should toggle the panel full screen within the panel strip, Zed-style: other panels hide temporarily, their state intact.

The ticket requires hidden panels to keep their drafts. Drafts are currently `useState` inside `ThreadView`, so hiding by unmounting would lose them. Decision: lift drafts into the session store and persist them in `workspace.json`, so a draft also survives closing the app before ever hitting send. This is a deliberate scope addition to HOY-181.

## Part 1: Drafts in the store, persisted

### Store (`src/state/store.ts`)

- New slice: `drafts: Record<string, string>` keyed by threadId, with action `setDraft(threadId: string, value: string): void`.
- `ThreadView` replaces its local `draft` state with the store value: `useSessionStore((s) => s.drafts[threadId] ?? "")` and `setDraft`. Submit keeps clearing the draft before sending, as today.
- `closePanel` does NOT clear the draft (unlike turns/stats/streaming/errors, which reset on close). `deleteThread` drops the draft entry.
- `isUntouched(thread, turns)` gains a drafts argument: a thread with a non-empty draft is touched. Consequences, all intentional:
  - a draft-only thread is persisted to disk (survives restart),
  - closing its panel keeps it in the sidebar instead of discarding it,
  - archiving it archives instead of deleting.

### Persistence

- `WsThread` (Rust, `src-tauri/src/workspace.rs`) gains `#[serde(default)] pub draft: Option<String>`; old workspace.json files load with `None`.
- The TS workspace thread shape (`src/lib/types.ts`) mirrors it: `draft?: string | null`.
- `persistProjects` takes the drafts record and writes `draft: drafts[t.id] || null` on each serialized thread (empty string stored as null).
- The autosave subscription fires when `state.drafts !== prev.drafts` in addition to `projects` changes. Same 300ms debounce, same identical-payload skip, so steady typing coalesces and unchanged content never writes.
- `initWorkspace` reads each thread's `draft` back into the `drafts` record (skipping null/empty).
- The in-memory `Thread` objects do not carry the draft; it lives only in the `drafts` slice and is merged in/out at the persistence boundary.

## Part 2: Full screen

### Store

- New state: `expandedThreadId: string | null` (not persisted).
- New action `toggleFullScreen(threadId: string)`: sets `expandedThreadId` to the id, or null if it already equals it.
- `closePanel(id)` clears `expandedThreadId` when `id` matches. Archive and delete both route through `closePanel`, so they are covered.
- `openThread(id)` clears `expandedThreadId` when `id` differs from it (opening another thread from the sidebar exits full screen; the focus click on the expanded panel itself fires `openThread` with the same id and keeps it).
- Panel `width` values in the store stay untouched while full screen, so restore is exact: same panels, same widths, same order.

### App.tsx

- While `expandedThreadId` is set and matches an open panel, `panels.map` renders only that panel, at full width via CSS (`flex-1` instead of the fixed `style.width`), with no resize handles and no trailing filler div.
- If `expandedThreadId` matches no open panel (defensive), render the normal layout.
- Hidden panels unmount. Their turns, streaming flags, stats, and drafts all live in the store, so streaming continues while hidden and the transcript and draft are intact on restore. Transcript scroll restores to the stick-to-bottom default. Per-panel local UI state (the HOY-180 expanded-editor flag) resets on remount; accepted.

### ContextBar (`src/components/ContextBar.tsx`)

- While a panel is full screen, render only that thread's stats slice, full width (`flex-1` instead of the fixed width). The scroll-sync mirroring is moot with a single slice.

### ThreadView header button

- The dead `Maximize2` button gets `onClick={() => toggleFullScreen(threadId)}`, flips to `Minimize2` while this thread is expanded, and is wrapped in a Tooltip reading "Full Screen" / "Exit Full Screen" (aria-label matches).

## Out of scope

- Persisting `expandedThreadId` across restarts.
- Preserving hidden panels' local UI state (composer expansion, transcript scroll offset).
- Restoring the strip's horizontal scroll offset after exiting full screen (both containers re-clamp; the footer sync effect keeps them aligned).

## Testing

- Store tests (`bun:test`, `tests/`):
  - `setDraft` round trip; draft survives `closePanel`; `deleteThread` drops it.
  - A draft-only thread is not discarded as untouched on `closePanel`.
  - `toggleFullScreen` sets and clears; `closePanel` of the expanded thread clears; `openThread` of a different thread clears; `openThread` of the expanded thread keeps it.
  - Panel widths are unchanged after a full screen round trip.
- Rust test: extend the workspace round-trip test with `draft` set and unset, plus a missing-field load (old file shape) defaulting to `None`.
- Manual acceptance: with 3 panels open, full-screening the middle one shows only it full width with only its footer slice; toggling back restores all 3 with previous widths; streaming in a hidden panel continues and its transcript is intact when restored; tooltips match state; a typed draft survives app restart.
