# Panel Full Screen + Persistent Drafts Implementation Plan (HOY-181)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the thread header's full screen button toggle the panel to fill the strip (other panels hidden, state intact), and lift composer drafts into the store with workspace.json persistence so they survive hiding, closing, and app restarts.

**Architecture:** Drafts move from `ThreadView` local state to a `drafts: Record<threadId, string>` store slice, persisted as an optional `draft` field on each thread in workspace.json (Rust `WsThread` + TS `Thread` both gain it, backward compatible). Full screen is `expandedThreadId: string | null` in the store; `App.tsx` renders only that panel at full CSS width, store widths untouched; `ContextBar` mirrors with a single full-width slice.

**Tech Stack:** Zustand store, bun:test, Rust serde for the workspace file. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-05-panel-full-screen-design.md`

---

### Task 1: Rust workspace `draft` field

**Files:**
- Modify: `src-tauri/src/workspace.rs`

- [x] **Step 1: Extend the round-trip test and add a missing-field test**

In the `tests` module, update `sample()` to set a draft and add a default test:

```rust
    fn sample() -> Workspace {
        Workspace {
            projects: vec![WsProject {
                id: "p1".into(),
                name: "hoy".into(),
                path: Some("/home/u/code/hoy".into()),
                threads: vec![WsThread {
                    id: "t1".into(),
                    title: "ticket HOY-28".into(),
                    updated_at: 1_717_000_000_000,
                    session_file: Some("/home/u/.hoy/agent/sessions/abc/s1.jsonl".into()),
                    archived: false,
                    renamed: true,
                    draft: Some("unsent composer text".into()),
                }],
            }],
        }
    }
```

In `round_trips_projects_and_threads`, after the `renamed` assert:

```rust
        assert_eq!(t.draft.as_deref(), Some("unsent composer text"));
```

New test at the end of the module (old files without the field must load as `None`):

```rust
    #[test]
    fn pre_draft_files_load_with_none() {
        let path = temp_path("nodraft");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].draft.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workspace`
Expected: compile error, `WsThread` has no field `draft`.

- [x] **Step 3: Add the field**

In `WsThread`, after `renamed`:

```rust
    // Unsent composer text, restored into the editor on reopen.
    #[serde(default)]
    pub draft: Option<String>,
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml workspace`
Expected: all workspace tests pass, including `pre_draft_files_load_with_none`.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/workspace.rs
git commit -m "HOY-181: workspace threads carry an optional draft field"
```

### Task 2: Store drafts slice with persistence

**Files:**
- Modify: `src/lib/types.ts` (Thread interface)
- Modify: `src/state/store.ts`
- Test: `tests/drafts.test.ts` (new)

- [x] **Step 1: Write the failing tests**

Create `tests/drafts.test.ts`:

```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread, Workspace } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

const saveWorkspace = mock<(ws: unknown) => Promise<void>>();
const loadWorkspace = mock<() => Promise<Workspace>>();

mockIpcModule({ saveWorkspace, loadWorkspace });

const { useSessionStore } = await import("@/state/store");

function seed(drafts: Record<string, string> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          // Untouched: never prompted, never renamed.
          { id: "t_untouched", title: "New thread", updatedAt: 1, sessionId: null },
          // Prompted: has a transcript on disk.
          {
            id: "t_sent",
            title: "New thread",
            updatedAt: 2,
            sessionId: null,
            sessionFile: "/tmp/s.jsonl",
          },
        ],
      },
    ],
    panels: [],
    drafts,
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
    activeThreadId: null,
  });
}

function threadIds(): string[] {
  return useSessionStore.getState().projects[0]?.threads.map((t) => t.id) ?? [];
}

beforeEach(() => {
  saveWorkspace.mockReset();
  loadWorkspace.mockReset();
});

describe("drafts slice", () => {
  test("setDraft stores and overwrites the value", () => {
    seed();
    useSessionStore.getState().setDraft("t_sent", "hello");
    expect(useSessionStore.getState().drafts.t_sent).toBe("hello");
    useSessionStore.getState().setDraft("t_sent", "hello again");
    expect(useSessionStore.getState().drafts.t_sent).toBe("hello again");
  });

  test("draft survives closePanel", () => {
    seed({ t_sent: "unsent text" });
    useSessionStore.setState({
      panels: [{ id: "t_sent", width: 600 }],
      activeThreadId: "t_sent",
    });
    useSessionStore.getState().closePanel("t_sent");
    expect(useSessionStore.getState().drafts.t_sent).toBe("unsent text");
  });

  test("a draft-only thread is kept on closePanel", () => {
    seed({ t_untouched: "started typing" });
    useSessionStore.setState({
      panels: [{ id: "t_untouched", width: 600 }],
      activeThreadId: "t_untouched",
    });
    useSessionStore.getState().closePanel("t_untouched");
    expect(threadIds()).toContain("t_untouched");
  });

  test("a whitespace-only draft does not keep an untouched thread", () => {
    seed({ t_untouched: "   " });
    useSessionStore.setState({
      panels: [{ id: "t_untouched", width: 600 }],
      activeThreadId: "t_untouched",
    });
    useSessionStore.getState().closePanel("t_untouched");
    expect(threadIds()).not.toContain("t_untouched");
  });

  test("archiving a draft-only thread archives instead of deleting", () => {
    seed({ t_untouched: "started typing" });
    useSessionStore.getState().archiveThread("t_untouched");
    const thread = useSessionStore
      .getState()
      .projects[0].threads.find((t) => t.id === "t_untouched");
    expect(thread?.archived).toBe(true);
  });

  test("deleteThread drops the draft", () => {
    seed({ t_sent: "unsent" });
    useSessionStore.getState().deleteThread("t_sent");
    expect(useSessionStore.getState().drafts.t_sent).toBeUndefined();
  });
});

describe("draft persistence", () => {
  test("a draft change alone triggers autosave and the payload carries it", async () => {
    loadWorkspace.mockResolvedValue({ projects: [] });
    saveWorkspace.mockResolvedValue(undefined);
    await useSessionStore.getState().initWorkspace();
    seed();
    // Let the seed's own projects-change autosave drain first.
    await new Promise((r) => setTimeout(r, 400));
    saveWorkspace.mockClear();

    useSessionStore.getState().setDraft("t_sent", "persist me");
    await new Promise((r) => setTimeout(r, 400));

    expect(saveWorkspace).toHaveBeenCalled();
    const payload = saveWorkspace.mock.calls.at(-1)?.[0] as Workspace;
    const thread = payload.projects[0].threads.find((t) => t.id === "t_sent");
    expect(thread?.draft).toBe("persist me");
  });

  test("initWorkspace restores drafts into the slice and off the threads", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: null,
          threads: [
            {
              id: "t1",
              title: "T",
              updatedAt: 1,
              sessionFile: "/tmp/s.jsonl",
              draft: "restored",
            } as Thread,
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    expect(useSessionStore.getState().drafts.t1).toBe("restored");
    expect(
      useSessionStore.getState().projects[0].threads[0].draft,
    ).toBeUndefined();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/drafts.test.ts`
Expected: FAIL (setDraft is not a function, drafts undefined).

- [x] **Step 3: Add the `draft` field to the Thread type**

In `src/lib/types.ts`, inside `interface Thread` after `renamed`:

```ts
  // Unsent composer text, present only in the persisted workspace shape; the
  // live value lives in the store's drafts slice.
  draft?: string | null;
```

- [x] **Step 4: Add the drafts slice to the store**

In `src/state/store.ts`:

In `interface SessionStore`, after `threadErrors`:

```ts
  // Composer drafts keyed by threadId. Store-held so hidden panels and app
  // restarts keep unsent text; persisted via the workspace autosave as each
  // thread's draft field. Never cleared on panel close.
  drafts: Record<string, string>;
```

and with the actions, after `closePanel`:

```ts
  setDraft: (threadId: string, value: string) => void;
```

In the initial state, after `threadErrors: {}`:

```ts
  drafts: {},
```

With the actions (place after `closePanel`):

```ts
  setDraft: (threadId, value) =>
    set((s) => ({ drafts: { ...s.drafts, [threadId]: value } })),
```

- [x] **Step 5: Teach isUntouched about drafts and update its callers**

Replace `isUntouched`:

```ts
// A thread the user never invested in: no prompt ever sent (no transcript on
// disk or in memory), never renamed, and no unsent draft. Untouched threads
// are never persisted and are discarded when their panel closes or they are
// archived.
function isUntouched(
  thread: Thread,
  turns: Record<string, Turn[]>,
  drafts: Record<string, string>,
): boolean {
  return (
    !thread.sessionFile &&
    !turns[thread.id]?.length &&
    !thread.renamed &&
    !drafts[thread.id]?.trim()
  );
}
```

Callers:
- `closePanel`: `const discard = found ? isUntouched(found.thread, s.turns, s.drafts) : false;`
- `archiveThread`: `if (found && isUntouched(found.thread, get().turns, get().drafts)) {`
- `persistProjects`: updated in Step 6.

In `closePanel`'s returned object, drop the draft entry only when discarding the thread (hygiene; a discarded thread has no meaningful draft by definition). Above the `return`:

```ts
      const { [id]: _dr, ...remainingDrafts } = s.drafts;
```

and in the returned object:

```ts
        drafts: discard ? remainingDrafts : s.drafts,
```

In `deleteThread`, drop the draft entry in the final `set`:

```ts
    set((s) => {
      const { [threadId]: _d, ...drafts } = s.drafts;
      return {
        drafts,
        projects: s.projects.map((p) => ({
          ...p,
          threads: p.threads.filter((t) => t.id !== threadId),
        })),
      };
    });
```

- [x] **Step 6: Persist and restore drafts**

`persistProjects` gains a drafts parameter and writes the field:

```ts
function persistProjects(
  projects: Project[],
  turns: Record<string, Turn[]>,
  drafts: Record<string, string>,
): void {
  const payload = {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path ?? null,
      // Untouched threads never reach disk: they vanish on restart even if
      // their panel was left open, and legacy empty rows in an existing
      // workspace.json drop off on the next save.
      threads: p.threads
        .filter((t) => !isUntouched(t, turns, drafts))
        .map((t) => ({
          id: t.id,
          title: t.title,
          updatedAt: t.updatedAt,
          sessionFile: t.sessionFile ?? null,
          archived: !!t.archived,
          renamed: !!t.renamed,
          draft: drafts[t.id] || null,
        })),
    })),
  };
```

(rest of the function unchanged.)

The autosave subscription also fires on drafts changes:

```ts
useSessionStore.subscribe((state, prev) => {
  if (state.projects === prev.projects && state.drafts === prev.drafts) return;
  if (!hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Read at fire time: the debounce window may batch several changes, and
    // the untouched filter needs the turns that exist when the write happens.
    const s = useSessionStore.getState();
    persistProjects(s.projects, s.turns, s.drafts);
  }, 300);
});
```

`initWorkspace` splits drafts out of the loaded threads (keep the existing backfill comment above the mapping):

```ts
      const drafts: Record<string, string> = {};
      const projects = (ws.projects ?? []).map((p) => ({
        ...p,
        threads: p.threads.map((t) => {
          // Drafts live in the drafts slice, not on the in-memory thread.
          const { draft, ...rest } = t;
          if (draft) drafts[rest.id] = draft;
          return !rest.renamed && !rest.sessionFile && rest.title !== "New thread"
            ? { ...rest, renamed: true }
            : rest;
        }),
      }));
      set({ projects, drafts });
```

- [x] **Step 7: Run tests to verify they pass**

Run: `bun test tests/drafts.test.ts`
Expected: PASS, all tests.

Run: `bun test`
Expected: full suite passes (the untouchedThreads tests exercise the same paths).

### Task 3: ThreadView reads the draft from the store

**Files:**
- Modify: `src/components/ThreadView.tsx`

- [x] **Step 1: Swap local draft state for the store slice**

Replace:

```tsx
  const [draft, setDraft] = useState("");
```

with:

```tsx
  const draft = useSessionStore((s) => s.drafts[threadId] ?? "");
  const setDraft = useSessionStore((s) => s.setDraft);
```

In `handleSubmit`, replace `setDraft("")` with:

```tsx
    setDraft(threadId, "");
```

In the `composer` element, replace `onChange={setDraft}` with:

```tsx
      onChange={(value) => setDraft(threadId, value)}
```

- [x] **Step 2: Build**

Run: `bun run build`
Expected: tsc and vite exit 0.

- [x] **Step 3: Commit**

```bash
git add src/lib/types.ts src/state/store.ts src/components/ThreadView.tsx tests/drafts.test.ts
git commit -m "HOY-181: composer drafts live in the store and persist in workspace.json"
```

### Task 4: Store full screen state

**Files:**
- Modify: `src/state/store.ts`
- Test: `tests/fullScreen.test.ts` (new)

- [x] **Step 1: Write the failing tests**

Create `tests/fullScreen.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

const WIDTHS = { t1: 400, t2: 500, t3: 300 };

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
          { id: "t3", title: "C", updatedAt: 3, sessionId: null, sessionFile: "/tmp/c.jsonl" },
        ],
      },
    ],
    panels: [
      { id: "t1", width: WIDTHS.t1 },
      { id: "t2", width: WIDTHS.t2 },
      { id: "t3", width: WIDTHS.t3 },
    ],
    bodyWidth: 1200,
    activeThreadId: "t2",
    expandedThreadId: null,
    drafts: {},
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
  });
}

describe("toggleFullScreen", () => {
  test("sets and clears the expanded thread", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("panel widths are untouched through a full screen round trip", () => {
    seed();
    const before = useSessionStore.getState().panels.map((p) => p.width);
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().panels.map((p) => p.width)).toEqual(before);
  });
});

describe("full screen clears on lifecycle events", () => {
  test("closing the expanded thread clears it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().closePanel("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("closing another thread keeps it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });

  test("archiving the expanded thread clears it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().archiveThread("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("opening a different thread exits full screen", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().openThread("t3");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
    expect(useSessionStore.getState().activeThreadId).toBe("t3");
  });

  test("re-opening the expanded thread keeps full screen", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().openThread("t2");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test tests/fullScreen.test.ts`
Expected: FAIL (toggleFullScreen is not a function).

- [x] **Step 3: Add the state and action**

In `src/state/store.ts`:

In `interface SessionStore`, after the `drafts` field:

```ts
  // Full screen within the panel strip: the one panel rendered while set.
  // Widths in panels stay untouched so exiting restores the exact layout.
  // Not persisted.
  expandedThreadId: string | null;
```

with the actions, after `setDraft`:

```ts
  toggleFullScreen: (threadId: string) => void;
```

In the initial state, after `drafts: {}`:

```ts
  expandedThreadId: null,
```

With the actions, after `setDraft`:

```ts
  toggleFullScreen: (threadId) =>
    set((s) => ({
      expandedThreadId: s.expandedThreadId === threadId ? null : threadId,
    })),
```

- [x] **Step 4: Clear on close and on opening another thread**

In `openThread`, both return paths clear full screen unless the opened thread is the expanded one (the focus click on the expanded panel re-opens the same id):

```ts
  openThread: (id) => {
    set((s) => {
      // Opening a different thread while full screen exits it: the user asked
      // to see something else.
      const expandedThreadId = s.expandedThreadId === id ? s.expandedThreadId : null;
      if (s.panels.some((p) => p.id === id))
        return { activeThreadId: id, expandedThreadId };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return {
        panels: [...panels, { id, width }],
        activeThreadId: id,
        expandedThreadId,
      };
    });
    void get().hydrateThread(id);
  },
```

In `closePanel`'s returned object (archive and delete route through here):

```ts
        expandedThreadId: s.expandedThreadId === id ? null : s.expandedThreadId,
```

- [x] **Step 5: Run tests to verify they pass**

Run: `bun test tests/fullScreen.test.ts`
Expected: PASS, all tests.

Run: `bun test`
Expected: full suite passes.

### Task 5: ThreadView header button

**Files:**
- Modify: `src/components/ThreadView.tsx`

- [x] **Step 1: Wire the button**

Add `Minimize2` to the lucide import in `ThreadView.tsx` (alongside `Maximize2`).

Add the selectors next to the other store reads:

```tsx
  const fullScreen = useSessionStore((s) => s.expandedThreadId === threadId);
  const toggleFullScreen = useSessionStore((s) => s.toggleFullScreen);
```

Replace the dead header button:

```tsx
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Expand"
          >
            <Maximize2 className="size-3.5" />
          </Button>
```

with:

```tsx
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => toggleFullScreen(threadId)}
                aria-label={fullScreen ? "Exit Full Screen" : "Full Screen"}
              >
                {fullScreen ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullScreen ? "Exit Full Screen" : "Full Screen"}
            </TooltipContent>
          </Tooltip>
```

- [x] **Step 2: Build**

Run: `bun run build`
Expected: exit 0.

### Task 6: App and ContextBar layout

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ContextBar.tsx`

- [x] **Step 1: App renders only the expanded panel while set**

Add the selector next to the other store reads in `App()`:

```tsx
  const expandedThreadId = useSessionStore((s) => s.expandedThreadId);
```

and derive (after the selectors):

```tsx
  const expandedPanel = panels.find((p) => p.id === expandedThreadId) ?? null;
```

Inside the strip div, replace the `panels.map(...)` block and the trailing filler with a conditional. The expanded branch reuses the same wrapper semantics (focus on pointer down, active accent) but takes full width via `flex-1` and skips handles and filler; the normal branch is today's code unchanged:

```tsx
                  {expandedPanel ? (
                    <div
                      onPointerDownCapture={() => focusPanel(expandedPanel.id)}
                      className={cn(
                        "flex min-h-0 flex-1 flex-col border-t-2",
                        expandedPanel.id === activeThreadId
                          ? "border-t-brand/70"
                          : "border-t-transparent",
                      )}
                    >
                      <ThreadView
                        threadId={expandedPanel.id}
                        active={expandedPanel.id === activeThreadId}
                        onClose={() => closePanel(expandedPanel.id)}
                        onDebug={handleDebug}
                        busy={busy}
                        debug={debug}
                        error={error}
                      />
                    </div>
                  ) : (
                    <>
                      {panels.map((panel, i) => (
                        <Fragment key={panel.id}>
                          <div
                            style={{ width: panel.width }}
                            onPointerDownCapture={() => focusPanel(panel.id)}
                            className={cn(
                              "flex min-h-0 shrink-0 flex-col border-r border-t-2 border-r-border",
                              panel.id === activeThreadId
                                ? "border-t-brand/70"
                                : "border-t-transparent",
                            )}
                          >
                            <ThreadView
                              threadId={panel.id}
                              active={panel.id === activeThreadId}
                              onClose={() => closePanel(panel.id)}
                              onDebug={handleDebug}
                              busy={busy}
                              debug={debug}
                              error={error}
                            />
                          </div>
                          {i < panels.length - 1 && (
                            <PanelResizeHandle index={i} />
                          )}
                        </Fragment>
                      ))}
                      {/* Unused workspace beside the panels: new panels dock here. */}
                      <div className="min-h-0 flex-1 bg-background" />
                    </>
                  )}
```

- [x] **Step 2: ContextBar mirrors the layout**

In `ContextBar`, add the selector and derived panel:

```tsx
  const expandedThreadId = useSessionStore((s) => s.expandedThreadId);
```

```tsx
  const expandedPanel = panels.find((p) => p.id === expandedThreadId) ?? null;
```

Replace the slices map:

```tsx
      <div ref={slicesRef} className="flex flex-1 items-stretch overflow-x-hidden">
        {expandedPanel ? (
          <PanelStats
            threadId={expandedPanel.id}
            fullWidth
            inset={collapsed}
          />
        ) : (
          panels.map((panel, i) => (
            <PanelStats
              key={panel.id}
              threadId={panel.id}
              width={panel.width}
              inset={collapsed && i === 0}
            />
          ))
        )}
      </div>
```

`PanelStats` grows a `fullWidth` variant (width becomes optional):

```tsx
function PanelStats({
  threadId,
  width,
  inset = false,
  fullWidth = false,
}: {
  threadId: string;
  width?: number;
  inset?: boolean;
  fullWidth?: boolean;
}) {
```

and its container div:

```tsx
    <div
      style={fullWidth ? undefined : { width }}
      className={cn(
        "flex shrink-0 items-center gap-3 border-r border-border px-3 font-mono tabular-nums",
        fullWidth && "flex-1 border-r-0",
        inset && "pl-10",
      )}
    >
```

- [x] **Step 3: Build and full test suite**

Run: `bun run build && bun test`
Expected: both pass.

- [x] **Step 4: Commit**

```bash
git add src/state/store.ts src/App.tsx src/components/ContextBar.tsx src/components/ThreadView.tsx tests/fullScreen.test.ts
git commit -m "HOY-181: thread header button toggles the panel full screen"
```

### Task 7: Manual acceptance and ticket

- [x] **Step 1: Manual acceptance in the running app**

Launch with `bun run tauri:dev`. Checks:
- Open 3 thread panels, resize them unevenly. Full-screen the middle one: only it renders, full width, with only its footer slice (full width). Icon flips to minimize; tooltips read "Full Screen" before, "Exit Full Screen" while expanded.
- Toggle back: all 3 panels return with their previous widths and order.
- Type a draft in panel A, full-screen panel B, exit: A's draft is intact.
- Type a draft, quit the app entirely, relaunch: the draft is back in the composer.
- Open a different thread from the sidebar while full screen: full screen exits.
- Close the full-screened panel: layout returns to the remaining panels.
- Streaming continues while hidden: start a prompt in panel A, full-screen panel B, wait, exit; A's transcript contains the finished response. (Costs one live prompt; skip if no key is configured and note it.)

- [x] **Step 2: Move HOY-181 to Done**

Update the Linear ticket with the verification summary and commit hashes.
