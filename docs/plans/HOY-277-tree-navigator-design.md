# Session Tree Navigator (`/tree`) — Design

Epic: HOY-277. Builds on HOY-221 (the `get_entries` / `get_tree` read surface, already wired end to end). Reference: `docs/pi-rpc-coverage.md`.

## Summary

Give Hoy a `/tree` navigator: a graphical view of a thread's session-entry tree, with the ability to branch a new line of conversation from any earlier point. This is Hoy's take on pi's `/tree` command, realized in Hoy's idiom rather than ported literally.

Full parity is the target, phased. **Phase 1** ships the value: see the tree, and branch any entry into a new thread. **Phase 2** adds true pi parity — in-place rewind of the same thread, label writes, and branch summaries.

## Prior art: what pi's `/tree` does

pi sessions **are** trees. A session is one JSONL file where every entry has `id` / `parentId`; a `leafId` marks the active tip. "Branching" moves the leaf to an earlier entry so the next message becomes a new child. `/tree` is an interactive navigator over that structure.

- **View**: half-screen ASCII tree, box-drawing indentation, active leaf marked `← active`, labels inline as `[name]`, children sorted oldest-first.
- **Nav**: ↑/↓ depth-first, ←/→ page, fold/unfold, Enter select, Esc cancel, Ctrl+O cycles filter modes (`default` / `no-tools` / `user-only` / `labeled-only` / `all`), Shift+L set/clear label, Shift+T toggle label timestamps.
- **Select**: a user message → move leaf to its parent, drop its text in the editor, edit + resubmit → new branch. A non-user entry → move leaf there, continue. Root user message → reset to empty, prompt back in the editor.
- **Branch summaries**: when switching away from a branch, pi can summarize the abandoned branch and attach it at the new position (a `BranchSummaryEntry`).
- **Related commands**: `/fork` (new file from an earlier user message), `/clone` (duplicate active branch into a new file).

## The architectural fact that shapes everything

There are **two trees** in Hoy, and they do not currently meet:

1. **pi's entry tree** — internal to one sidecar's JSONL file (`id`/`parentId`/`leafId`), surfaced read-only by `get_tree` / `get_entries`. **Today every Hoy session is linear** — nothing calls `fork`/`branch`, so each file's tree is a straight chain.
2. **Hoy's thread tree** — `Thread.parentThreadId`, one sidecar + one file per node, already rendered by `FleetTree.tsx` and the sidebar.

Two hard constraints from the code:

- **Hoy's sidecar runs pi's stock `runRpcMode`** (`packages/sidecar/pi-src/hoy-sidecar.ts:206`). So the RPC surface is exactly pi's: `fork` / `clone` / `get_fork_messages` exist, but pi's *in-place* leaf move (`SessionManager.branch()`, the heart of TUI `/tree`) is **not an RPC command**. Neither are label writes nor branch summaries (the coverage doc already flags "session tree label APIs" as SDK-only).
- **pi's `fork` / `clone` RPC hijack the running session** (`.../dist/core/agent-session-runtime.js:171-243`). `fork(entryId)` writes a new file via `createBranchedSession()` (with `parentSession` → the old file), then **tears down the current runtime and repoints that same sidecar to the new file**, emitting `session_start{reason:"fork"}`. Calling it on a live Hoy thread would silently switch that thread's file out from under `Thread.sessionFile` (the thread's durable identity).

## Decision: branches are new threads, realized through Hoy's own spawn path

Rather than call pi's hijacking `fork`/`clone`, branch through the mechanism Hoy already uses to sidestep `new_session`/`switch_session`: **spawn a fresh sidecar for a new thread, seeded from a branched copy of the source file.**

`hoy-sidecar.ts:186-197` already selects its session at spawn from env — open an existing file / `SessionManager.forkFrom(inheritFrom)` (subagent inheritance) / create fresh. Add a **fourth mode**: branch-at-entry = `SessionManager.open(source)` + `createBranchedSession(entryId)`, then run `runRpcMode` on the resulting file. The source thread is never touched; the branch is a new `Thread` with `parentThreadId` = source, appearing in both the FleetTree and the sidebar.

This gives pi's *capability* (explore alternate paths from any point) in Hoy's idiom: each branch is an independent, resumable, nameable thread. It is arguably better UX than pi's in-place model — you never lose your current position — and it reuses the entire existing thread-tree surface. `fork`/`clone`/`get_fork_messages` stay unused; the coverage doc note holds.

### Phase 2 exception: true in-place rewind

Some users will want pi's exact behavior — rewind the *same* thread without spawning a new one. That is `SessionManager.branch(entryId)`: it moves the leaf **within the same file** (no new file, no identity swap), and the next prompt becomes a new child. Because it is not in stock RPC, Phase 2 adds a **custom command to the branded sidecar** by wrapping `runRpcMode`'s dispatch. Same-file, so it is actually the *safer* of the two mechanics — it just isn't reachable today.

## Phase 1 — View + branch-to-new-thread

The shippable core. Five tickets; the first is a design spike so the rest build to a real spec.

### 1. UX design spike (design skill)

Resolve the interaction and visual questions *before* implementation, output mockups + a short visual spec the impl tickets build to. Must answer:

- **Placement.** Right-side slide-over vs a `bodyView` (like `FleetBoard`) vs a centered command-palette overlay. Different keyboard model and focus behavior each.
- **Graphical tree language.** Hoy renders a real graphical tree (connectors, indentation, node cards) — not an ASCII port. Node treatment per entry type (message / tool / compaction / model-change / label), active-leaf treatment, how branch points read.
- **The near-always-linear empty state.** Most sessions have no branches — the "tree" is a straight line. The design must make "branch from any point" the hero affordance (e.g. hover-reveal on every message) so a linear session still invites exploration, instead of opening to a boring vertical list.
- **Two-trees reconciliation.** The entry tree (within a thread) vs the FleetTree (across threads). Users will conflate them, especially since a branch spawns a node visible in both. Reconcile visually and in copy.
- **Click + continuity.** Clicking a node: scroll the main transcript to it / inline preview / nothing. Where focus goes after a branch (open the new thread? toast?).
- **Discoverability & controls.** `/tree` slash command + keybinding + optional button; filter modes as a real segmented control (not pi's hidden Ctrl+O cycle); label display.

Acceptance: a written visual spec + mockups covering all six, reviewed before tickets 3–5 start.

### 2. Tree read-store slice

A per-thread `sessionTree` slice on the Zustand store, mirroring the `slashCommands` / `stats` per-`threadId` record pattern (`state/store.ts`).

- Fetch via `getTree(thread.sessionId)` (already in `lib/ipc.ts:210`) on panel open; gate on a live `sessionId` like `refreshCommands` (`store.ts:1398`).
- Refresh on turn `done` and when `leafId` changes. Optionally use `getEntries(sessionId, since)` for incremental reads later; not required for v1.
- Scope subscriptions with `useShallow` so streaming deltas don't re-render the tree (the `FleetTree` pattern).

Acceptance: opening `/tree` on a thread with a live session shows its current entries; sending a message refreshes the tree; no re-render storm during streaming.

### 3. Tree navigator UI

Build to the spike spec. Recursive renderer over `SessionTreeNode.children` (pi pre-nests it — no map-building, unlike `FleetTree`'s `childrenMap`), `DEPTH_PADDING`-style indentation, active-leaf highlight, entry-type-aware rows, collapse/expand, keyboard nav (↑/↓ depth-first, Enter, Esc), and the linear empty state from the spec.

- **Filter modes** ride here — pure client-side over the already-fetched tree (`default` / `no-tools` / `user-only` / `labeled-only` / `all`); `get_tree` returns everything including types and `node.label`.
- Reuse existing message/tool rendering from the transcript components where practical.

Acceptance criteria (UX, from the spike): active leaf unmistakable; linear session still surfaces the branch affordance; keyboard-navigable; filters work; matches the visual spec.

### 4. `branchFromEntry` sidecar spawn mode (backend)

The write primitive. Add the fourth spawn mode end to end:

- `hoy-sidecar.ts`: new env (e.g. `HOY_BRANCH_FROM_ENTRY` + `HOY_BRANCH_SOURCE_FILE`) → `SessionManager.open(source)` then `createBranchedSession(entryId)`, run `runRpcMode` on the new file.
- `create_session` (`src-tauri/src/commands.rs:301`): new optional param alongside `inherit_from_session`, plumbed as env to the spawn (`sidecar.rs`).
- Registered in `lib.rs`; a behavior-pinning test like the `get_tree`/`get_entries` ones (`commands.rs:725`).

Acceptance: given a source file and an `entryId`, spawning produces a new session file whose branch ends at that entry, with `parentSession` set; the source file is unchanged.

### 5. "Branch from here" action

Wire the affordance from the spike to the backend from ticket 4. From any entry in the navigator, spawn a child thread on the branched file — reuse the `spawnChildThread` / `acquireSession` path (`store.ts:2143`, `:2248`) with the new `branchFromEntry` param, set `parentThreadId` = source. If the entry is a user message, prefill the composer with its text (pi's behavior). Apply the spike's focus/feedback decision (open the new thread + toast, or similar).

Acceptance: branching from an entry creates a new thread nested under the source in the FleetTree/sidebar, seeded to that point; the source thread is untouched; focus/feedback matches the spec.

## Phase 2 — True in-place rewind + full parity

Three tickets, each with UX acceptance criteria. Each is independently shippable on top of Phase 1.

### 6. Custom sidecar RPC: `branch` / set-leaf (in-place rewind)

Wrap `runRpcMode`'s dispatch in the branded sidecar to add a `branch` command calling `SessionManager.branch(entryId)` (leaf moves in the same file; next prompt becomes a child). New Tauri passthrough + `lib/ipc.ts` wrapper. In the navigator, "rewind here" on the *current* thread (vs "branch to new thread"). If the entry is a user message, prefill the composer with its text. No new file, no thread-identity change.

UX acceptance: the current thread visibly rewinds to the chosen point; the transcript reflects the new active branch; the old branch remains in the tree, navigable.

### 7. Labels (write)

Reads are already free (`node.label` / `labelTimestamp` from `get_tree`). Add a custom sidecar RPC over `SessionManager.appendLabelChange(targetId, label)` + Tauri passthrough + wrapper. `Shift+L` (or a row action) to set/clear; labels render inline and power the `labeled-only` filter.

UX acceptance: setting a label persists (survives reopen), renders in the tree, and drives the filter.

### 8. Branch summaries

On an in-place branch switch, optionally summarize the abandoned branch and attach it at the new position, mirroring pi's prompt (no summary / default / custom focus). Backed by `SessionManager.branchWithSummary(...)` via the custom sidecar command from ticket 6.

UX acceptance: switching branches offers the summarize choice; a chosen summary appears as a `branch_summary` entry at the new position and in context.

## Out of scope (v1 of the epic)

- Wiring pi's hijacking `fork` / `clone` / `get_fork_messages` RPC — superseded by the new-thread spawn path.
- Handling `session_start{reason:"fork"}` events — Hoy never triggers the hijack, so nothing emits them.
- Cross-thread tree merging / a unified entry+thread graph view — the two trees stay distinct; reconciliation is visual (spike), not structural.

## Risks and open questions

- **`createBranchedSession` semantics.** Confirm it writes a standalone file cut at `targetLeafId` with `parentSession` set, and does not mutate the source. (Read in `session-manager`; the Phase 1 ticket 4 test pins it.)
- **Placement decision cascades.** The spike's placement choice (overlay vs bodyView vs slide-over) affects tickets 3 and 5; keep 3–5 gated behind the spike.
- **Refresh cost.** `get_tree` returns the full tree each call; for very long sessions consider the `getEntries(since)` incremental path before shipping if refreshes lag.
- **Custom-command wrapping (Phase 2).** Adding commands means wrapping `runRpcMode` dispatch without forking pi's loop; verify the branded sidecar can intercept cleanly on the pinned version before committing ticket 6.
