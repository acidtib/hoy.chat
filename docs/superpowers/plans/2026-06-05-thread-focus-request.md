# Sidebar Click Scroll-to-Panel and Composer Focus Implementation Plan (HOY-183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a thread in the sidebar (open or not) scrolls its panel into view and focuses its composer, while clicks inside a panel never move composer focus.

**Architecture:** `focusRequest: { threadId, nonce } | null` in the store, set by `openThread` with an incrementing nonce. App's panel pointer-down handlers move to a new `focusPanel(id)` action that only sets `activeThreadId`. ThreadView consumes the request: scrolls its root into view and passes the nonce to Composer as a `focusSignal` prop, which focuses the textarea.

**Tech Stack:** Zustand store, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-05-thread-focus-request-design.md`

---

### Task 1: Store focusRequest and focusPanel

**Files:**
- Modify: `src/state/store.ts`
- Test: `tests/focusRequest.test.ts` (new)

- [x] **Step 1: Write the failing tests**

Create `tests/focusRequest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "A", updatedAt: 1, sessionId: null, sessionFile: "/tmp/a.jsonl" },
          { id: "t2", title: "B", updatedAt: 2, sessionId: null, sessionFile: "/tmp/b.jsonl" },
        ],
      },
    ],
    panels: [{ id: "t1", width: 600 }],
    bodyWidth: 1200,
    activeThreadId: "t1",
    expandedThreadId: null,
    focusRequest: null,
    drafts: {},
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
  });
}

describe("openThread sets focusRequest", () => {
  test("already-open thread: request carries the threadId", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    expect(useSessionStore.getState().focusRequest).toEqual({
      threadId: "t1",
      nonce: 1,
    });
  });

  test("repeat clicks bump the nonce", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().openThread("t1");
    expect(useSessionStore.getState().focusRequest?.nonce).toBe(2);
  });

  test("fresh-open thread also gets a request", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    expect(useSessionStore.getState().focusRequest?.threadId).toBe("t2");
    expect(useSessionStore.getState().panels.map((p) => p.id)).toContain("t2");
  });

  test("addThread leaves a request for the new thread", () => {
    seed();
    const id = useSessionStore.getState().addThread("p1");
    expect(useSessionStore.getState().focusRequest?.threadId).toBe(id);
  });
});

describe("focusPanel", () => {
  test("sets activeThreadId without touching focusRequest or full screen", () => {
    seed();
    useSessionStore.setState({
      panels: [
        { id: "t1", width: 600 },
        { id: "t2", width: 600 },
      ],
      expandedThreadId: "t2",
    });
    useSessionStore.getState().focusPanel("t2");
    expect(useSessionStore.getState().activeThreadId).toBe("t2");
    expect(useSessionStore.getState().focusRequest).toBeNull();
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/focusRequest.test.ts`
Expected: FAIL (focusPanel is not a function; focusRequest stays null).

- [x] **Step 3: Add state and actions**

In `src/state/store.ts`:

In `interface SessionStore`, after `expandedThreadId`:

```ts
  // One-shot composer focus request, set by openThread (a user asking to see
  // the thread) and consumed by ThreadView/Composer in an effect. The nonce
  // makes repeat clicks on the same thread re-fire. focusPanel (a pointer
  // landing inside a panel) never sets it, so in-panel clicks cannot yank
  // focus into the composer. Not persisted.
  focusRequest: { threadId: string; nonce: number } | null;
```

with the actions, after `openThread`:

```ts
  focusPanel: (id: string) => void;
```

In the initial state, after `expandedThreadId: null`:

```ts
  focusRequest: null,
```

In `openThread`, set the request on both paths:

```ts
  openThread: (id) => {
    set((s) => {
      // Opening a different thread while full screen exits it: the user asked
      // to see something else.
      const expandedThreadId =
        s.expandedThreadId === id ? s.expandedThreadId : null;
      const focusRequest = {
        threadId: id,
        nonce: (s.focusRequest?.nonce ?? 0) + 1,
      };
      if (s.panels.some((p) => p.id === id))
        return { activeThreadId: id, expandedThreadId, focusRequest };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return {
        panels: [...panels, { id, width }],
        activeThreadId: id,
        expandedThreadId,
        focusRequest,
      };
    });
    void get().hydrateThread(id);
  },
```

New action after `openThread`:

```ts
  // Pointer-down focus inside an open panel: active accent only, no composer
  // focus and no full screen change.
  focusPanel: (id) => set({ activeThreadId: id }),
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite passes (new file plus the 53 existing tests).

- [x] **Step 5: Commit**

```bash
git add src/state/store.ts tests/focusRequest.test.ts
git commit -m "HOY-183: openThread records a focus request; focusPanel only activates"
```

### Task 2: Wire App, ThreadView, Composer

**Files:**
- Modify: `src/App.tsx:34`
- Modify: `src/components/ThreadView.tsx`
- Modify: `src/components/Composer.tsx`

- [x] **Step 1: App uses focusPanel**

In `src/App.tsx`, replace:

```tsx
  const focusPanel = useSessionStore((s) => s.openThread);
```

with:

```tsx
  const focusPanel = useSessionStore((s) => s.focusPanel);
```

(Both pointer-down call sites already use the `focusPanel` binding.)

- [x] **Step 2: ThreadView consumes the request**

In `src/components/ThreadView.tsx`:

Add `useEffect` and `useRef` to the react import:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
```

Add selectors next to the other store reads:

```tsx
  const focusSignal = useSessionStore((s) =>
    s.focusRequest?.threadId === threadId ? s.focusRequest.nonce : 0,
  );
```

Add a root ref and the scroll effect (after the store reads, before `handleSubmit`):

```tsx
  // Scroll the panel into view when this thread is the focus request target
  // (sidebar/history click or fresh open). Composer handles the focus itself
  // via the same signal.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusSignal) return;
    rootRef.current?.scrollIntoView({
      behavior: "smooth",
      inline: "nearest",
      block: "nearest",
    });
  }, [focusSignal]);
```

Attach the ref to the root div:

```tsx
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
```

Pass the signal to the Composer (with the other props):

```tsx
      focusSignal={focusSignal}
```

- [x] **Step 3: Composer focuses on signal**

In `src/components/Composer.tsx`, add `useEffect` to the react import:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
```

Add the prop after `onToggleExpand`:

```tsx
  onToggleExpand,
  focusSignal = 0,
}: {
  ...
  onToggleExpand?: () => void;
  focusSignal?: number;
}) {
```

Add the effect after the auto-grow `useLayoutEffect`:

```tsx
  // Click-driven focus: a non-zero signal focuses, including on mount (the
  // fresh-open path mounts with its own brand-new request). Re-renders with an
  // unchanged signal never re-fire. Remounts with a STALE request (exit full
  // screen, reopen) are prevented at the source: the store clears the request
  // on closePanel/toggleFullScreen (Step 4).
  useEffect(() => {
    if (focusSignal) textareaRef.current?.focus();
  }, [focusSignal]);
```

- [x] **Step 4: Stale-request guard**

A `focusRequest` is one-shot but lives in the store until the next one. A ThreadView remount (exit full screen, reopening a closed panel) with a matching stale request would re-focus without a click. Guard at the source: `closePanel` and `toggleFullScreen` clear a matching `focusRequest` so a remount never sees a stale one.

In `src/state/store.ts`, in `closePanel`'s returned object (next to the `expandedThreadId` clear):

```ts
        focusRequest:
          s.focusRequest?.threadId === id ? null : s.focusRequest,
```

and `toggleFullScreen` becomes:

```ts
  toggleFullScreen: (threadId) =>
    set((s) => ({
      expandedThreadId: s.expandedThreadId === threadId ? null : threadId,
      // Entering or exiting full screen remounts panels; drop any pending
      // request so the remount cannot replay it.
      focusRequest: null,
    })),
```

Add to `tests/focusRequest.test.ts`:

```ts
describe("stale requests are cleared", () => {
  test("closing the requested thread clears the request", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().focusRequest).toBeNull();
  });

  test("toggleFullScreen drops any pending request", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().toggleFullScreen("t1");
    expect(useSessionStore.getState().focusRequest).toBeNull();
  });
});
```

- [x] **Step 5: Build and full test suite**

Run: `bun run build && bun test`
Expected: both pass.

- [x] **Step 6: Commit**

```bash
git add src/App.tsx src/components/ThreadView.tsx src/components/Composer.tsx src/state/store.ts tests/focusRequest.test.ts
git commit -m "HOY-183: sidebar click scrolls to the panel and focuses its composer"
```

### Task 3: Manual acceptance and ticket

- [x] **Step 1: Manual acceptance in the running app**

Launch with `bun run tauri:dev`. Checks:
- Open enough panels to overflow the strip, scroll right, click the left-most open thread's sidebar row: the strip smooth-scrolls its panel into view and the composer has the caret.
- Click the visible focused thread's row: composer focused, no scroll jump.
- Click inside another panel's transcript or header: active accent moves, composer focus does not.
- Start an inline rename in a panel header, click another panel: rename editing keeps focus.
- Open a brand-new thread (sidebar plus button): panel appears scrolled into view with the composer focused.
- Full-screen a panel and exit: no unexpected composer focus on restore.

- [x] **Step 2: Move HOY-183 to Done**

Update the Linear ticket with the verification summary and commit hashes.
