# Subagent thread lifecycle (HOY-238/239/240) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliver-once + auto-close for finished child threads, and cascade archive/delete to children. Three small interacting `store.ts` fixes.

**Architecture:** A new terminal marker `Thread.completedAt` is both the deliver-once guard and the "done" signal; `deliverAndDrain` sets it and tears the child down; `archiveThread`/`deleteThread` cascade to `parentThreadId === id` children. Depth is capped at 1 (HOY-234), so a single non-recursive filter reaches every child.

**Tech Stack:** React + Zustand renderer, `bun test`, `bun run check:ts`.

## Global Constraints

- No emojis, no em-dashes anywhere (code, comments, docs, commits). Comma/semicolon or rewrite.
- Plain commit messages, per-ticket prefix (`HOY-239:` / `HOY-240:` / `HOY-238:`), no Co-Authored-By trailer.
- No new dependencies. Do NOT wire the Vercel AI SDK.
- `check:ts` must stay clean except the ONE pre-existing `bun:test` error in `src/state/delivery.test.ts` (tracked in HOY-242).
- Do not lose a child's transcript: `closePanel` keeps the durable `sessionFile`; never `deleteSessionFile` on a completed (non-deleted) child.
- Depth cap is 1: children never have children, so cascade is a single filter, not recursion.

## Shared interfaces (Task 1 adds the field + first helper; Task 3 adds the second)

```ts
// types.ts - Thread gains:
completedAt?: number | null; // epoch ms a child delivered its result; terminal marker + deliver-once guard

// delivery.ts
export function shouldDeliverToParent(thread: { parentThreadId?: string | null; completedAt?: number | null }): boolean;
export function childThreadIdsOf(projects: Project[], parentId: string): string[];
```

---

### Task 1: Deliver-once guard (HOY-239)

**Files:**
- Modify: `apps/desktop/src/lib/types.ts` (add `completedAt` to `Thread`)
- Modify: `apps/desktop/src/state/delivery.ts` (add `shouldDeliverToParent`)
- Modify: `apps/desktop/src/state/delivery.test.ts` (unit tests)
- Modify: `apps/desktop/src/state/store.ts` (`deliverAndDrain` guard + `markThreadCompleted`)

**Interfaces:**
- Produces: `shouldDeliverToParent(thread)`; `Thread.completedAt`.

- [ ] **Step 1: Failing test** (append to `delivery.test.ts`)

```ts
import { shouldDeliverToParent } from "./delivery";

test("shouldDeliverToParent: only a not-yet-completed child delivers", () => {
  expect(shouldDeliverToParent({ parentThreadId: "p1", completedAt: null })).toBe(true);
  expect(shouldDeliverToParent({ parentThreadId: "p1", completedAt: 123 })).toBe(false); // already delivered
  expect(shouldDeliverToParent({ parentThreadId: null, completedAt: null })).toBe(false); // not a child
  expect(shouldDeliverToParent({})).toBe(false);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts`
Expected: FAIL, `shouldDeliverToParent` not exported.

- [ ] **Step 3: Add the helper** (`delivery.ts`)

```ts
// A child delivers its result to its parent exactly once, on first completion.
// completedAt is set on that first delivery; a later done (e.g. a follow-up in
// the child's own composer) sees it set and does not re-inject. HOY-239.
export function shouldDeliverToParent(thread: {
  parentThreadId?: string | null;
  completedAt?: number | null;
}): boolean {
  return !!thread.parentThreadId && !thread.completedAt;
}
```

- [ ] **Step 4: Add `completedAt` to `Thread`** (`types.ts`, near `spawnedBy`/`parentThreadId`)

```ts
  // Epoch ms a child delivered its result to its parent. Terminal marker: set
  // once, on first delivery; gates deliver-once and signals a done child. HOY-239/240.
  completedAt?: number | null;
```

- [ ] **Step 5: Guard `deliverAndDrain`** (`store.ts`, the `if (thread.parentThreadId)` block ~1689-1697)

Replace the delivery block so it runs only when `shouldDeliverToParent(thread)` and stamps `completedAt` after delivering. Import `shouldDeliverToParent` from `./delivery` (the file already imports `buildDelivery`, `takeNextDelivery` from there).

```ts
  if (shouldDeliverToParent(thread)) {
    const childTurns = state.turns[finishedThreadId] ?? [];
    const delivery = buildDelivery(
      thread.spawnedBy?.type ?? "subagent",
      thread.spawnedBy?.agentId ?? "",
      childTurns,
    );
    await deliverToParent(thread.parentThreadId!, delivery);
    // Stamp terminal so a later done (follow-up) does not re-deliver. HOY-239.
    useSessionStore.setState((s) => ({
      projects: patchThread(s.projects, finishedThreadId, (th) => ({
        ...th,
        completedAt: th.completedAt ?? Date.now(),
      })),
    }));
  }
```

Leave the queued-delivery drain below (`const next = takeNextDelivery(...)`) unchanged and outside this guard.

- [ ] **Step 6: Verify**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts` (green, existing 7 + new) and `bun run check:ts` (clean except the known `bun:test` error).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src/state/delivery.ts apps/desktop/src/state/delivery.test.ts apps/desktop/src/state/store.ts
git commit -m "HOY-239: deliver-once guard for child result delivery"
```

---

### Task 2: Auto-close the finished child (HOY-240)

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (`deliverAndDrain`, after the delivery in Task 1's guarded block)

**Interfaces:**
- Consumes: Task 1's guarded delivery block; existing `closePanel`.

- [ ] **Step 1: Tear the child down after delivery** (`store.ts`)

Inside the `shouldDeliverToParent` block from Task 1, AFTER stamping `completedAt`, close the child's panel (kills its sidecar, drops the cached turns, removes the panel if open; the durable `sessionFile` stays so the transcript is not lost):

```ts
    // Auto-close: a delivered child is terminal. closePanel kills its sidecar
    // and drops the panel; the sessionFile persists so reopening rehydrates
    // read-only. Reopen-to-continue is harmless (completedAt guard = no
    // re-deliver). Runs AFTER deliverToParent, which read the child's turns.
    useSessionStore.getState().closePanel(finishedThreadId);
```

- [ ] **Step 2: Verify no test regressions**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts` (still green) and `bun run check:ts` (clean except the known error). (The closePanel wiring is exercised at live-verify; no new unit.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/state/store.ts
git commit -m "HOY-240: auto-close a finished child thread on delivery"
```

---

### Task 3: Cascade archive + delete to children (HOY-238)

**Files:**
- Modify: `apps/desktop/src/state/delivery.ts` (add `childThreadIdsOf`)
- Modify: `apps/desktop/src/state/delivery.test.ts` (unit test)
- Modify: `apps/desktop/src/state/store.ts` (`archiveThread`, `deleteThread` cascade)

**Interfaces:**
- Consumes: `Project`/`Thread` types.
- Produces: `childThreadIdsOf(projects, parentId)`.

- [ ] **Step 1: Failing test** (append to `delivery.test.ts`)

```ts
import { childThreadIdsOf } from "./delivery";

test("childThreadIdsOf: returns ids of threads whose parentThreadId matches", () => {
  const projects = [
    { id: "p", name: "p", path: null, threads: [
      { id: "parent", title: "", updatedAt: 0, sessionId: null },
      { id: "kidA", title: "", updatedAt: 0, sessionId: null, parentThreadId: "parent" },
      { id: "kidB", title: "", updatedAt: 0, sessionId: null, parentThreadId: "parent" },
      { id: "other", title: "", updatedAt: 0, sessionId: null, parentThreadId: "somethingElse" },
    ] },
  ] as any;
  expect(childThreadIdsOf(projects, "parent").sort()).toEqual(["kidA", "kidB"]);
  expect(childThreadIdsOf(projects, "parent-with-no-kids")).toEqual([]);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts`
Expected: FAIL, `childThreadIdsOf` not exported.

- [ ] **Step 3: Add the helper** (`delivery.ts`)

```ts
import type { Project } from "../lib/types";

// Ids of the direct children of parentId (depth is capped at 1, so no
// grandchildren exist). Used to cascade archive/delete so a child is never
// orphaned rootless when its parent leaves the tree. HOY-238.
export function childThreadIdsOf(projects: Project[], parentId: string): string[] {
  return projects
    .flatMap((p) => p.threads)
    .filter((t) => t.parentThreadId === parentId)
    .map((t) => t.id);
}
```

(If `delivery.ts` lacks a `Project` import, add it; match the existing import style.)

- [ ] **Step 4: Cascade in `archiveThread`** (`store.ts:1413`)

At the top of `archiveThread`, before archiving the target, archive each child first (each via `get().archiveThread(childId)` so the untouched-child shortcut and `closePanel` teardown apply uniformly). Guard against the target being reprocessed:

```ts
  archiveThread: (threadId) => {
    // Cascade first so a child is never left rootless when its parent is
    // filtered out of the tree; archiveThread on each child reuses the same
    // untouched-delete + closePanel teardown. HOY-238.
    for (const childId of childThreadIdsOf(get().projects, threadId)) {
      get().archiveThread(childId);
    }
    // ...existing body unchanged...
  },
```

Import `childThreadIdsOf` from `./delivery`.

- [ ] **Step 5: Cascade in `deleteThread`** (`store.ts:1438`)

At the top of `deleteThread`, delete each child first (`get().deleteThread(childId)` - releases session, deletes the child's sessionFile, closes panel, removes from tree):

```ts
  deleteThread: (threadId) => {
    for (const childId of childThreadIdsOf(get().projects, threadId)) {
      get().deleteThread(childId);
    }
    // ...existing body unchanged...
  },
```

- [ ] **Step 6: Verify**

Run: `cd apps/desktop && bun test src/state/delivery.test.ts` (green) and `bun run check:ts` (clean except the known error).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/state/delivery.ts apps/desktop/src/state/delivery.test.ts apps/desktop/src/state/store.ts
git commit -m "HOY-238: cascade archive/delete to child subagent threads"
```

---

## Self-review

- Coverage: HOY-239 (Task 1 guard), HOY-240 (Task 2 auto-close), HOY-238 (Task 3 cascade). All three tickets mapped.
- Types: `completedAt?: number | null` used consistently; `shouldDeliverToParent`/`childThreadIdsOf` signatures match their tests and call sites.
- No placeholders; every code step carries complete code.
- Recursion: cascade is a single filter (depth cap 1) - no grandchildren, matches the design.
