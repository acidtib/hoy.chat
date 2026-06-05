# Streaming Teardown Confirm Implementation Plan (HOY-182)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing, archiving, or deleting a thread whose response is still streaming asks for confirmation first; idle threads keep the immediate behavior.

**Architecture:** A `pendingTeardown` store field with `requestTeardown` / `confirmTeardown` / `cancelTeardown` actions gates the three real actions in one place; `closePanel` / `archiveThread` / `deleteThread` stay untouched. One global `ConfirmCloseDialog` (shadcn AlertDialog) rendered in App consumes the pending state. All teardown call sites switch to `requestTeardown`.

**Tech Stack:** Zustand store, shadcn AlertDialog (Radix), bun:test.

**Spec:** `docs/superpowers/specs/2026-06-05-streaming-teardown-confirm-design.md`

---

### Task 1: Add the shadcn AlertDialog component

**Files:**
- Create: `src/components/ui/alert-dialog.tsx` (generated)

- [x] **Step 1: Install via the shadcn CLI**

Run: `bunx --bun shadcn@latest add alert-dialog`
Expected: writes `src/components/ui/alert-dialog.tsx` (the repo already has `components.json` and other shadcn ui files). If the CLI asks about overwriting unrelated files, decline; only alert-dialog should be added.

- [x] **Step 2: Verify the build still passes**

Run: `bun run build`
Expected: exit 0.

### Task 2: Store pendingTeardown slice

**Files:**
- Modify: `src/state/store.ts`
- Test: `tests/teardownConfirm.test.ts` (new)

- [x] **Step 1: Write the failing tests**

Create `tests/teardownConfirm.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed(streaming: Record<string, boolean> = {}) {
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
    panels: [
      { id: "t1", width: 600 },
      { id: "t2", width: 600 },
    ],
    bodyWidth: 1200,
    activeThreadId: "t1",
    expandedThreadId: null,
    focusRequest: null,
    pendingTeardown: null,
    drafts: {},
    turns: {},
    stats: {},
    streaming,
    threadErrors: {},
    modelSelecting: {},
  });
}

function panelIds(): string[] {
  return useSessionStore.getState().panels.map((p) => p.id);
}

function thread(id: string) {
  return useSessionStore
    .getState()
    .projects[0]?.threads.find((t) => t.id === id);
}

describe("requestTeardown on idle threads", () => {
  test("close runs immediately with nothing pending", () => {
    seed();
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(panelIds()).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("archive runs immediately", () => {
    seed();
    useSessionStore.getState().requestTeardown("archive", "t1");
    expect(thread("t1")?.archived).toBe(true);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("delete runs immediately", () => {
    seed();
    useSessionStore.getState().requestTeardown("delete", "t1");
    expect(thread("t1")).toBeUndefined();
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });
});

describe("requestTeardown on streaming threads", () => {
  test("parks the action and tears nothing down", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(panelIds()).toEqual(["t1", "t2"]);
    expect(useSessionStore.getState().pendingTeardown).toEqual({
      action: "close",
      threadId: "t1",
    });
  });

  test("cancel keeps the panel open and the stream flagged", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    useSessionStore.getState().cancelTeardown();
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
    expect(panelIds()).toEqual(["t1", "t2"]);
    expect(useSessionStore.getState().streaming.t1).toBe(true);
  });

  test("confirm close matches the direct action's end state", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(panelIds()).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("confirm archive archives and closes the panel", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("archive", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(thread("t1")?.archived).toBe(true);
    expect(panelIds()).toEqual(["t2"]);
  });

  test("confirm delete removes the thread", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("delete", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(thread("t1")).toBeUndefined();
    expect(panelIds()).toEqual(["t2"]);
  });

  test("confirm with nothing pending is a no-op", () => {
    seed();
    useSessionStore.getState().confirmTeardown();
    expect(panelIds()).toEqual(["t1", "t2"]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/teardownConfirm.test.ts`
Expected: FAIL (requestTeardown is not a function).

- [x] **Step 3: Implement the slice**

In `src/state/store.ts`:

In `interface SessionStore`, after `focusRequest`:

```ts
  // Teardown of a streaming thread asks first. requestTeardown gates the
  // three destructive actions in one place: idle threads tear down
  // immediately, streaming ones park here until the dialog confirms or
  // cancels. Not persisted.
  pendingTeardown: {
    action: "close" | "archive" | "delete";
    threadId: string;
  } | null;
```

with the actions, after `focusPanel`:

```ts
  requestTeardown: (
    action: "close" | "archive" | "delete",
    threadId: string,
  ) => void;
  confirmTeardown: () => void;
  cancelTeardown: () => void;
```

In the initial state, after `focusRequest: null`:

```ts
  pendingTeardown: null,
```

With the actions, after `focusPanel`:

```ts
  requestTeardown: (action, threadId) => {
    if (!get().streaming[threadId]) {
      runTeardown(get(), action, threadId);
      return;
    }
    set({ pendingTeardown: { action, threadId } });
  },

  confirmTeardown: () => {
    const pending = get().pendingTeardown;
    if (!pending) return;
    set({ pendingTeardown: null });
    runTeardown(get(), pending.action, pending.threadId);
  },

  cancelTeardown: () => set({ pendingTeardown: null }),
```

Module-level helper (near `findThread` at the bottom):

```ts
// Dispatch one of the three teardown actions; shared by requestTeardown's
// immediate path and confirmTeardown.
function runTeardown(
  s: SessionStore,
  action: "close" | "archive" | "delete",
  threadId: string,
): void {
  if (action === "close") s.closePanel(threadId);
  else if (action === "archive") s.archiveThread(threadId);
  else s.deleteThread(threadId);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite passes (60 existing + 9 new).

- [x] **Step 5: Commit**

```bash
git add src/state/store.ts tests/teardownConfirm.test.ts
git commit -m "HOY-182: requestTeardown gates streaming threads behind a pending confirm"
```

### Task 3: Dialog component and call sites

**Files:**
- Create: `src/components/ConfirmCloseDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/ThreadView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/ThreadHistory.tsx`

- [x] **Step 1: Create the dialog**

Create `src/components/ConfirmCloseDialog.tsx`:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/state/store";

const COPY = {
  close: { verb: "Close", button: "Stop and close" },
  archive: { verb: "Archive", button: "Stop and archive" },
  delete: { verb: "Delete", button: "Stop and delete" },
} as const;

// Global confirm for tearing down a streaming thread (close/archive/delete).
// Rendered once in App; driven by the store's pendingTeardown.
export function ConfirmCloseDialog() {
  const pending = useSessionStore((s) => s.pendingTeardown);
  const confirmTeardown = useSessionStore((s) => s.confirmTeardown);
  const cancelTeardown = useSessionStore((s) => s.cancelTeardown);

  const copy = pending ? COPY[pending.action] : null;

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) cancelTeardown();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Response still streaming</AlertDialogTitle>
          <AlertDialogDescription>
            A response is still streaming. {copy?.verb} this thread and stop
            the response?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancelTeardown}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmTeardown}
            className={cn(
              pending?.action === "delete" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {copy?.button}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [x] **Step 2: Render it in App and switch the close call sites**

In `src/App.tsx`:

```tsx
import { ConfirmCloseDialog } from "@/components/ConfirmCloseDialog";
```

Replace the `closePanel` selector with `requestTeardown`:

```tsx
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
```

(remove the now-unused `closePanel` selector), render the dialog next to the settings modal:

```tsx
      <SettingsModal />
      <ConfirmCloseDialog />
```

and change both `onClose` props:

```tsx
                        onClose={() => requestTeardown("close", expandedPanel.id)}
```

```tsx
                              onClose={() => requestTeardown("close", panel.id)}
```

- [x] **Step 3: Switch the archive and delete call sites**

`src/components/ThreadView.tsx`: replace the `archiveThread` selector with

```tsx
  const requestTeardown = useSessionStore((s) => s.requestTeardown);
```

and the menu item:

```tsx
              <DropdownMenuItem onSelect={() => requestTeardown("archive", threadId)}>
```

`src/components/Sidebar.tsx`: in the thread row component, replace the `archiveThread` selector with `requestTeardown` (same selector line as above) and the hover button handler:

```tsx
                onClick={(e) => {
                  e.stopPropagation();
                  requestTeardown("archive", thread.id);
                }}
```

`src/components/ThreadHistory.tsx`: replace the `archiveThread` and `deleteThread` selectors with `requestTeardown` and the row props:

```tsx
                    onArchive={() => requestTeardown("archive", thread.id)}
                    onUnarchive={() => unarchiveThread(thread.id)}
                    onDelete={() => requestTeardown("delete", thread.id)}
```

- [x] **Step 4: Build and full test suite**

Run: `bun run build && bun test`
Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add src/components/ConfirmCloseDialog.tsx src/components/ui/alert-dialog.tsx src/App.tsx src/components/ThreadView.tsx src/components/Sidebar.tsx src/components/ThreadHistory.tsx
git commit -m "HOY-182: confirm before tearing down a streaming thread"
```

### Task 4: Manual acceptance and ticket

- [x] **Step 1: Manual acceptance in the running app**

Launch with `bun run tauri:dev`. With a real response streaming (one short prompt):
- X on the streaming panel: dialog appears with "Stop and close"; Cancel keeps tokens flowing; X again and confirm closes the panel.
- Archive from the sidebar row hover and the header menu on a streaming thread: dialog with "Stop and archive".
- Delete from the history view on a streaming thread: dialog with "Stop and delete", destructive styling.
- Close/archive/delete an idle thread: immediate, no dialog.

- [x] **Step 2: Move HOY-182 to Done**

Update the Linear ticket with the verification summary and commit hashes.
