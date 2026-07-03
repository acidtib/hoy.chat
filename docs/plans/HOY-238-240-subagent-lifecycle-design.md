# Subagent thread lifecycle (HOY-238 / HOY-239 / HOY-240) - design

Wave 1 of the "finish shipping subagents" burn-down. Three small, interacting
`store.ts` fixes to the child-thread lifecycle. One branch
(`hoy-238-240-subagent-lifecycle`), one commit per ticket.

## Problem

Phase 2 (HOY-233) delivers a finished child's result to its parent via
`deliverAndDrain` (store.ts:1684), called from every thread `done`
(store.ts:1570). Three gaps remain:

- **HOY-239** every child `done` re-delivers. A completed child given a
  follow-up in its own composer produces a second `done` and injects a second
  result note into the parent.
- **HOY-240** a delivered child lingers as an open, idle, steerable thread with
  a live sidecar. No terminal end-state; clutter; keeps a sidecar process alive.
- **HOY-238** `archiveThread` (store.ts:1413) archives + `closePanel`s only the
  target. Archiving a parent that spawned a child leaves the child
  `archived:false` but rootless (its parent is filtered out), so it renders
  nowhere and its sidecar leaks until restart. `deleteThread` has the same gap.

## Design

### New field: `Thread.completedAt?: number | null`

A terminal marker: the epoch-ms a child delivered its result to its parent.
Set once, on first delivery. It is BOTH the deliver-once guard and the
"this child is done" signal. Persisted with the thread (workspace autosave), so
it survives restart.

### HOY-239 - deliver-once (default, not per-type)

In `deliverAndDrain`, gate the parent-delivery block on `!thread.completedAt`:

```
if (thread.parentThreadId && !thread.completedAt) {
  ...build delivery, await deliverToParent(parent, delivery)...
  // mark terminal so a later `done` (from a follow-up) does not re-deliver
  markThreadCompleted(finishedThreadId);
}
```

The queued-delivery drain below it (this thread may itself be a parent with a
queued delivery, store.ts:1700) is UNCHANGED and stays outside the guard.

Deliver-once is the default. Re-delivery was a niche-useful live observation in
HOY-233; orchestration wants once. Per-type configuration is YAGNI.

Testable unit: pure predicate `shouldDeliverToParent(thread): boolean` =
`!!thread.parentThreadId && !thread.completedAt`, unit-tested in
`delivery.test.ts` alongside the existing helpers.

### HOY-240 - auto-close the finished child

After the delivery in `deliverAndDrain` (same block, after `completedAt` is
set), tear the child down:

```
useSessionStore.getState().closePanel(finishedThreadId);
```

`closePanel` (store.ts:577) already: `releaseSession` (kills the child sidecar),
`activeChannels.delete`, drops the cached turns, and removes the panel if open.
The durable `sessionFile` stays on the thread, so the transcript is not lost -
reopening rehydrates from disk. The child stays in the projects tree as a
completed (`completedAt`-stamped) child, ready for FleetView (HOY-235) to render
a done state.

Terminal, but a deliberate reopen is safe: if the user reopens a completed child
and steers it, a new `done` fires, but the `completedAt` guard means it will NOT
re-deliver to the parent. So we do NOT need to disable the child's composer; the
guard makes reopen-to-continue harmless. (Order matters: deliver reads the
child's turns, so `closePanel` - which drops the turns cache - must run AFTER
`deliverToParent`.)

Not doing: auto-collapse variants, a reopen-confirm, concurrency-slot accounting
(no limiter exists yet). Those are FleetView-era concerns.

### HOY-238 - cascade archive + delete to children

Pure helper `childThreadIdsOf(projects, parentId): string[]` =
ids of threads whose `parentThreadId === parentId` (same project). Unit-tested.

- `archiveThread(id)`: before archiving the target, cascade to each child id -
  `closePanel(child)` (sidecar teardown) + set `archived:true`. Reuse the
  existing untouched-thread shortcut per child (an untouched child is deleted,
  matching the target's own behavior).
- `deleteThread(id)`: cascade delete to each child id (`releaseSession` +
  `deleteSessionFile` + `closePanel` + remove from tree).
- `unarchiveThread`: NOT cascaded. Restoring a parent does not auto-restore
  cascade-archived children (no record of which were cascade vs manual); the
  user unarchives a child explicitly if wanted. YAGNI.

Depth is 1 (the absolute depth cap, HOY-234), so a single non-recursive filter
covers every child; no grandchildren exist.

## Files

- `apps/desktop/src/lib/types.ts` - add `completedAt?: number | null` to `Thread`.
- `apps/desktop/src/state/delivery.ts` - `shouldDeliverToParent`,
  `childThreadIdsOf` pure helpers.
- `apps/desktop/src/state/delivery.test.ts` - unit tests for both.
- `apps/desktop/src/state/store.ts` - `deliverAndDrain` guard + auto-close;
  `archiveThread`/`deleteThread` cascade; a small `markThreadCompleted` setter.

## Out of scope (tracked elsewhere)

Auto-open spawned threads + color identity (HOY-236, Wave 2); FleetView
rendering of the done state (HOY-235, Wave 3); per-type deliver config /
concurrency limiter (not planned).
