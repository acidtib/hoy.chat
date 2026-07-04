# Session Tree Navigator (`/tree`) — Design

Epic: HOY-277. Builds on HOY-221 (the `get_entries` / `get_tree` read surface, already wired end to end). Reference: `docs/pi-rpc-coverage.md`.

## Summary

Give Hoy a `/tree` navigator: a graphical view of a thread's session-entry tree, with the ability to branch a new line of conversation from any earlier point. This is Hoy's take on pi's `/tree`, and it is deliberately built **entirely on pi's RPC surface** so that future pi changes to the tree feature are a version bump, not a rewrite.

## Guiding principle: stay on pi's stable contract

pi's **RPC command surface is the stable contract**; its SDK internals (`SessionManager` methods, session-file format) are not. Any capability we build by reaching into `SessionManager` directly — a custom leaf-move command, a custom branch-at-spawn mode, direct `createBranchedSession` calls — is exactly what breaks when pi refactors. So this design uses **only** RPC commands and events. Where pi's tree feature has behavior that is *not* in the RPC contract (same-file in-place leaf move, label writes, branch summaries), we do **not** reimplement it against SDK internals; we mark it as out of scope until pi promotes it to RPC.

## Prior art: what pi's `/tree` does

pi sessions **are** trees. A session is one JSONL file where every entry has `id` / `parentId`; a `leafId` marks the active tip. `/tree` is an interactive navigator over that structure: half-screen ASCII tree, active leaf marked `← active`, labels inline, filter modes, keyboard nav; selecting an entry moves the leaf and lets you branch. Related commands: `/fork` (new file from an earlier user message), `/clone` (duplicate the active branch into a new file).

Of that, the RPC contract exposes: `get_tree` / `get_entries` (read), `fork` / `clone` / `get_fork_messages` (write), and the `session_start` event. It does **not** expose the same-file leaf move (`SessionManager.branch()`), label writes (`appendLabelChange`), or branch summaries (`branchWithSummary`) — those are TUI/SDK only.

## The two constraints from the code

1. **Hoy's sidecar runs pi's stock `runRpcMode`** (`packages/sidecar/pi-src/hoy-sidecar.ts:206`). We speak exactly pi's RPC. Good — that is the contract we want to depend on.
2. **`fork` / `clone` switch the calling sidecar to a new file** (`.../dist/core/agent-session-runtime.js:171-243`). `fork(entryId)` writes a **new** file via `createBranchedSession()` (original preserved on disk, `parentSession` → old file), tears down the current runtime, repoints that sidecar to the new file, and emits `session_start{reason:"fork", previousSessionFile}`. So using `fork`/`clone` means **handling `session_start`** (currently unmapped in `sidecar.rs`) and deciding what the file switch means for the Hoy thread.

## Decision: branch = `fork` = new file = new Hoy thread

Every branch is a `fork`/`clone` over RPC, which produces a new session file, which Hoy surfaces as a **thread** (linked by `parentSession` / `Thread.parentThreadId`, shown in the existing `FleetTree` and sidebar). This is both the RPC-native path *and* the natural fit for Hoy's model, where a thread already **is** one session file. Two shapes, both pure RPC:

- **Branch to a new thread, source untouched** — run `fork(entryId)` on a **fresh** sidecar opened on the source file; it becomes the new thread on the branched file while the source thread's sidecar never moves.
- **Fork the current thread in place** — run `fork` on the thread's **own** sidecar; catch `session_start`, update `Thread.sessionFile` to the new file. The old file remains on disk as the pre-fork line (optionally surfaced as a sibling thread via `parentSession`).

Which shape a given UI action uses is a spike decision (see ticket 1). Both are the same RPC + event plumbing.

No custom sidecar command, no custom spawn mode, no direct `SessionManager` calls from Hoy. `fork` / `clone` / `get_fork_messages` move from "unused" to "used"; `session_start` gets mapped. Every coverage-doc gap in the tree feature that *is* in the RPC contract gets closed.

## Phase 1 — View + fork/clone branching (RPC-native core)

Six tickets. The first is a design spike so the rest build to a real spec.

### 1. UX design spike (design skill)

Resolve interaction/visual questions *before* implementation; output mockups + a short visual spec the impl tickets build to. Must answer:

- **Placement.** Right-side slide-over vs a `bodyView` (like `FleetBoard`) vs a centered command-palette overlay — each a different keyboard/focus model.
- **Graphical tree language.** A real graphical tree (connectors, indentation, node cards), not an ASCII port. Per-entry-type node treatment (message / tool / compaction / model-change / label), active-leaf treatment, how branch points read.
- **The near-always-linear empty state.** Most sessions have no branches yet — the "tree" is a straight line. Make "branch from any point" the hero affordance (e.g. hover-reveal on every message) so a linear session still invites exploration.
- **Two-trees reconciliation.** The entry tree (within a thread) vs the FleetTree (across threads). Since a `fork` produces a node visible in both, reconcile them visually and in copy. Decide whether the branch action is "new thread" or "fork in place" (or both, as distinct affordances).
- **Click + continuity.** Clicking a node: scroll the transcript to it / inline preview / nothing. Where focus goes after a fork (open the new thread? toast?).
- **Discoverability & controls.** `/tree` slash + keybinding + optional button; filter modes as a real segmented control (not pi's hidden Ctrl+O cycle); label display (read-only in Phase 1).

Acceptance: a written visual spec + mockups covering all six, reviewed before tickets 3–6 start.

### 2. Tree read-store slice

Per-thread `sessionTree` slice on the Zustand store, mirroring the `slashCommands` / `stats` per-`threadId` pattern (`state/store.ts`). Fetch via `getTree(thread.sessionId)` (`lib/ipc.ts:210`) on panel open, gated on a live `sessionId` (cf. `refreshCommands`, `store.ts:1398`). Refresh on turn `done` and on `leafId` change. Scope subscriptions with `useShallow` so streaming deltas don't re-render the tree (the `FleetTree` pattern).

Acceptance: opening `/tree` on a live thread shows its entries; sending a message refreshes it; no re-render storm during streaming.

### 3. Tree navigator UI

Build to the spike spec. Recursive renderer over `SessionTreeNode.children` (pi pre-nests it — no `childrenMap` build, unlike `FleetTree`), `DEPTH_PADDING`-style indentation, active-leaf highlight, entry-type-aware rows, collapse/expand, keyboard nav (↑/↓ depth-first, Enter, Esc), and the linear empty state. **Filter modes** ride here — pure client-side over the fetched tree (`default` / `no-tools` / `user-only` / `labeled-only` / `all`); `get_tree` already returns types and `node.label`. Reuse transcript message/tool rendering where practical.

Acceptance (UX, from the spike): active leaf unmistakable; linear session still surfaces the branch affordance; keyboard-navigable; filters work; matches the visual spec.

### 4. Wire `fork` / `clone` / `get_fork_messages` RPC

The write surface, as Tauri passthrough commands + `lib/ipc.ts` wrappers, mirroring how `get_entries` / `get_tree` were wired in HOY-221 (`commands.rs:365-391`, `lib.rs:129-130`, `ipc.ts:203-217`). `get_fork_messages` backs the "forkable entries" picker (pi-native, matches pi's `/fork` UI exactly). Behavior-pinning tests like the existing `get_tree` one (`commands.rs:725`).

Acceptance: from a live session, `fork(entryId)` returns `{text, cancelled}` and produces a new branched file with `parentSession` set; `clone` returns `{cancelled}` and duplicates the active branch; `get_fork_messages` lists forkable user messages.

### 5. Map the `session_start` event

`fork`/`clone` switch the sidecar's file and emit `session_start{reason, previousSessionFile}`, currently unmapped (`sidecar.rs:365` `map_pi_event`). Map it to a renderer `AgentEvent` so the store learns when a sidecar's underlying file changes. This is the infra that makes fork-in-place safe (the thread's `sessionFile` can follow the switch) and is generally useful.

Acceptance: after a `fork`/`clone`, the renderer receives a mapped event carrying the new + previous session file paths; the store can react.

### 6. Branch/fork action

Wire the spike's affordance to the RPC from ticket 4 + the event from ticket 5. Reuse the `spawnChildThread` / `acquireSession` path (`store.ts:2143`, `:2248`) for the "new thread" shape (fresh sidecar → `fork` → new thread, `parentThreadId` = source), or the in-place shape (fork the thread's own sidecar → `session_start` → update `sessionFile`), per the spike. If the forked entry is a user message, prefill the composer with its text (pi's behavior). Apply the spike's focus/feedback decision.

Acceptance: branching from an entry produces a new thread nested under the source in the FleetTree/sidebar, seeded to that point; the source thread is intact; focus/feedback matches the spec.

## Phase 2 — Parity extras

### 7. `/fork` and `/clone` as first-class slash commands

Surface `fork`/`clone` as Hoy slash commands with a `get_fork_messages`-backed picker, matching pi's command UX. Fully RPC-native; sits on ticket 4's plumbing.

Acceptance: `/fork` opens the forkable-message picker and creates a branch thread; `/clone` duplicates the current thread.

### 8. Labels + branch summaries — **blocked on pi RPC**

pi's label writes (`appendLabelChange`) and branch summaries (`branchWithSummary`) are **not** in the RPC contract — only reads (`node.label` via `get_tree`) are. Implementing writes means SDK-internal calls, which is precisely the maintenance risk this design avoids. So: **reads only in Phase 1** (labels render, drive the `labeled-only` filter); **writes deferred** until pi exposes them over RPC. This ticket tracks that dependency; do not build it against SDK internals.

## Out of scope

- **Same-file in-place leaf move** (pi's `SessionManager.branch()`): not in the RPC contract. Hoy's equivalent is a new-file `fork` surfaced as a thread, which fits Hoy's model. Revisit only if pi adds a set-leaf RPC.
- **Label / branch-summary writes**: SDK-only today (see ticket 8).
- **Cross-thread tree merging / a unified entry+thread graph**: the two trees stay distinct; reconciliation is visual (spike), not structural.

## Risks and open questions

- **`session_start` mapping shape.** Confirm the event carries the new session file path (it should, via the runtime's `session_start` payload) so the store can repoint `sessionFile`. Ticket 5 pins it.
- **Double-open safety (new-thread fork).** The "fresh sidecar forks the source file" shape briefly opens the source file in a second sidecar. `fork` only reads the source and writes the new file; verify no write contention with the source's live sidecar (branch from a settled point). Alternatively use the in-place shape.
- **Placement cascades.** The spike's placement choice affects tickets 3 and 6; keep them gated behind the spike.
- **Refresh cost.** `get_tree` returns the full tree each call; for very long sessions consider `getEntries(since)` incremental reads before shipping if refreshes lag.
- **Label/summary write parity.** Tracked as blocked (ticket 8) rather than solved, by design.
