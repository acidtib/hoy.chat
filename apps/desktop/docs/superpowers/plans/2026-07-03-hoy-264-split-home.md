# HOY-264 Split Home Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped combined home dashboard with a clean "start a new task" hero built on the real Hoy composer, and move the usage stats into their own full-screen Usage view opened from a footer icon next to the fleet toggle.

**Architecture:** Reuse the presentational `Composer.tsx` on home, fed by local React state, submitting through a new `startThread` store action (create-and-send, so threads are only minted on send). The Usage dashboard (unchanged data pipeline) moves into a `UsageView` rendered by `App.tsx` as a third `bodyView` value, toggled from `ContextBar`.

**Tech Stack:** React + TypeScript, Zustand store, Tailwind v4 + shadcn, bun test.

## Global Constraints

- No emojis and no em-dashes in code, comments, docs, or commit messages. Use plain hyphens.
- Commit messages are plain, prefixed `HOY-264:` (or `test:` / `chore:`), NO Co-Authored-By trailer. Commits stay LOCAL on `main`; never push unless explicitly asked.
- Dev/live tests use `~/.hoyd` (debug branded dir). NEVER touch production `~/.hoy`. Clean up any test session dirs afterward.
- Gate: `bun run check` (tsc, cargo check, clippy, fmt) and `bun test`, both from `apps/desktop`. Frontend-only tasks need `bun run check:ts` + `bun test`.
- Square dark theme (`--radius: 0`, hairline `border border-border`). The home composer must be the real `Composer.tsx`, Hoy-styled - not a ZCode clone. The branch pill is a STATIC MOCK (no git switching).
- Do NOT touch `usage_stats.rs`, the `get_usage_stats` command, or `src/lib/usage.ts` (HOY-262 pipeline is reused as-is).

---

## File Structure

- New `src/components/home/HomeComposer.tsx` - local-state wrapper around `Composer`; calls `startThread` on submit. One responsibility: drive the hero composer.
- Rewrite `src/components/HomePage.tsx` - the hero (watermark, title, project+branch header, `HomeComposer`, recents). No stats.
- New `src/components/UsageView.tsx` - full-body, width-constrained wrapper around `UsageDashboard`.
- Modify `src/components/home/UsageDashboard.tsx` - desktop-width layout (6 cards in a row, trend + models side by side).
- Modify `src/components/home/ActivityHeatmap.tsx` - fill-width, no horizontal scroll.
- Modify `src/App.tsx` - `bodyView === "usage"` branch.
- Modify `src/components/ContextBar.tsx` - second footer toggle for Usage.
- Modify `src/state/store.ts` - `startThread` action; `bodyView`/`setBodyView` gain `"usage"`.
- Delete `src/components/home/TaskComposer.tsx`.
- New `tests/startThread.test.ts`.

Note: `UsageDashboard.tsx`, `ActivityHeatmap.tsx`, `StatCard.tsx`, etc. currently live in `src/components/home/`. Keep them there.

---

### Task 1: `startThread` store action

**Files:**
- Modify: `src/state/store.ts`
- Test: `tests/startThread.test.ts`

**Interfaces:**
- Consumes: existing `addThread(projectId): string`, `selectModel(threadId, provider, modelId)`, `setPermissionMode(threadId, mode)`, `selectThinkingLevel(threadId, level)`, `submitPrompt(threadId, message, images?, behavior?)`.
- Produces: `startThread(projectId: string, message: string, opts: { model: ModelRef | null; permissionMode: PermissionMode; thinkingLevel: ThinkingLevel; images?: ImageContent[] }): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/startThread.test.ts`:

```ts
import { beforeEach, expect, test, mock } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [],
    panels: [],
    activeThreadId: null,
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
beforeEach(seed);

test("startThread creates a thread in the project, records the picks, and submits", () => {
  useSessionStore.getState().addProject("/tmp/p");
  const projId = useSessionStore.getState().projects[0].id;
  const before = useSessionStore.getState().projects[0].threads.length;

  // Isolate startThread's orchestration from the real send path.
  const submitPrompt = mock(async () => {});
  useSessionStore.setState({ submitPrompt });

  useSessionStore.getState().startThread(projId, "do the thing", {
    model: { provider: "anthropic", id: "opus" },
    permissionMode: "acceptEdits",
    thinkingLevel: "high",
  });

  const threads = useSessionStore.getState().projects[0].threads;
  expect(threads.length).toBe(before + 1);
  const t = threads[0]; // addThread prepends
  expect(t.model).toEqual({ provider: "anthropic", id: "opus" });
  expect(t.permissionMode).toBe("acceptEdits");
  expect(t.thinkingLevel).toBe("high");
  expect(submitPrompt).toHaveBeenCalledTimes(1);
  expect(submitPrompt.mock.calls[0][0]).toBe(t.id);
  expect(submitPrompt.mock.calls[0][1]).toBe("do the thing");
});

test("startThread with no model still records permission/thinking and submits", () => {
  useSessionStore.getState().addProject("/tmp/q");
  const projId = useSessionStore.getState().projects[0].id;
  const submitPrompt = mock(async () => {});
  useSessionStore.setState({ submitPrompt });

  useSessionStore.getState().startThread(projId, "hi", {
    model: null,
    permissionMode: "default",
    thinkingLevel: "high",
  });

  const t = useSessionStore.getState().projects[0].threads[0];
  expect(t.permissionMode).toBe("default");
  expect(submitPrompt).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && bun test ./tests/startThread.test.ts`
Expected: FAIL (`startThread is not a function`).

- [ ] **Step 3: Add the type to the store interface**

In `src/state/store.ts`, in the actions interface right after the `submitPrompt` signature (around line 509), add:

```ts
  // Create a thread from the home hero and send its first prompt in one step
  // (HOY-264). Records the chosen model/permission/thinking on the new
  // session-less thread, opens it (addThread), and submits; submitPrompt lazily
  // spawns the session and applies the deferred picks. The thread is only minted
  // here, on send, so opening home and leaving creates no empty thread.
  startThread: (
    projectId: string,
    message: string,
    opts: {
      model: ModelRef | null;
      permissionMode: PermissionMode;
      thinkingLevel: ThinkingLevel;
      images?: ImageContent[];
    },
  ) => void;
```

`ModelRef`, `PermissionMode`, `ThinkingLevel`, and `ImageContent` are already imported in store.ts (used by `defaultModel`, `setPermissionMode`, `selectThinkingLevel`, and `submitPrompt`). If tsc reports any as missing, add it to the existing `import type { ... } from "@/lib/types";` block.

- [ ] **Step 4: Implement the action**

In `src/state/store.ts`, add the implementation next to `submitPrompt`'s implementation (after the `submitPrompt: async (...) => { ... }` block near line 1174). The picks are recorded synchronously by `selectModel`/`setPermissionMode`/`selectThinkingLevel` (they defer sidecar work when the thread has no session), so `submitPrompt` sees them at spawn time:

```ts
  startThread: (projectId, message, opts) => {
    const id = get().addThread(projectId);
    if (opts.model) {
      void get().selectModel(id, opts.model.provider, opts.model.id);
    }
    void get().setPermissionMode(id, opts.permissionMode);
    void get().selectThinkingLevel(id, opts.thinkingLevel);
    void get().submitPrompt(id, message, opts.images);
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test ./tests/startThread.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run check:ts` -> clean.

```bash
cd /home/acidtib/Code/hoy
git add apps/desktop/src/state/store.ts apps/desktop/tests/startThread.test.ts
git commit -m "HOY-264: add startThread create-and-send store action"
```

---

### Task 2: `HomeComposer` component

**Files:**
- Create: `src/components/home/HomeComposer.tsx`

**Interfaces:**
- Consumes: `startThread` (Task 1); `Composer` from `@/components/Composer`; store `models`, `defaultModel`, `projects`.
- Produces: `<HomeComposer projectId={string} projectPath={string | null} />`.

- [ ] **Step 1: Implement**

Create `src/components/home/HomeComposer.tsx`. This mirrors ThreadView's composer wiring (ThreadView.tsx:245-276) but drives everything from local state and submits via `startThread`:

```tsx
import { useCallback, useMemo, useState } from "react";
import { Composer } from "@/components/Composer";
import { useSessionStore } from "@/state/store";
import { listProjectPaths } from "@/lib/ipc";
import { fileToImageAttachment } from "@/lib/images";
import { modelSupportsImages } from "@/lib/types";
import type {
  ImageAttachment,
  ModelRef,
  PermissionMode,
  SlashCommand,
  ThinkingLevel,
} from "@/lib/types";

// The hero composer on home (HOY-264). Reuses the real Composer, but holds its
// draft/model/permission/thinking/attachments in LOCAL state so no thread is
// created until submit. On submit it hands off to startThread (create-and-send).
const NO_SLASH: SlashCommand[] = [];

export function HomeComposer({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string | null;
}) {
  const models = useSessionStore((s) => s.models);
  const defaultModel = useSessionStore((s) => s.defaultModel);
  const projects = useSessionStore((s) => s.projects);
  const startThread = useSessionStore((s) => s.startThread);

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [thinking, setThinking] = useState<ThinkingLevel>("high");

  const currentModel = model ?? defaultModel;
  const activeModel = currentModel
    ? models.find(
        (m) => m.provider === currentModel.provider && m.id === currentModel.id,
      ) ?? null
    : null;
  const canAttachImages = modelSupportsImages(activeModel);

  const searchPaths = useCallback(
    (query: string) =>
      projectPath ? listProjectPaths(projectPath, query, 50) : Promise.resolve([]),
    [projectPath],
  );
  const contextThreads = useMemo(
    () =>
      projects.flatMap((p) =>
        p.threads.map((t) => ({ threadId: t.id, title: t.title })),
      ),
    [projects],
  );

  async function handleAddFiles(files: File[]) {
    const added = await Promise.all(files.map(fileToImageAttachment));
    setAttachments((a) => [...a, ...added]);
  }

  function handleSubmit() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    startThread(projectId, draft, {
      model: currentModel,
      permissionMode: mode,
      thinkingLevel: thinking,
      images: attachments.length ? attachments.map((a) => a.content) : undefined,
    });
    setDraft("");
    setAttachments([]);
  }

  return (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={() => handleSubmit()}
      models={models}
      currentModel={currentModel}
      selecting={false}
      onSelectModel={(provider, modelId) => setModel({ provider, id: modelId })}
      mode={mode}
      onSelectMode={setMode}
      thinking={thinking}
      onSelectThinking={setThinking}
      streaming={false}
      fill
      autoFocus
      placeholder="Ask hoy, @ files, / commands..."
      widgets={[]}
      attachments={attachments}
      onAddFiles={(files) => void handleAddFiles(files)}
      onRemoveAttachment={(id) =>
        setAttachments((a) => a.filter((x) => x.id !== id))
      }
      canAttachImages={canAttachImages}
      searchPaths={searchPaths}
      threads={contextThreads}
      slashCommands={NO_SLASH}
      projectPath={projectPath}
    />
  );
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean. (If `modelSupportsImages`/`fileToImageAttachment` import paths are flagged, confirm against `src/lib/types.ts:250` and `src/lib/images.ts:26`.)

```bash
cd /home/acidtib/Code/hoy
git add apps/desktop/src/components/home/HomeComposer.tsx
git commit -m "HOY-264: add HomeComposer wrapping the real composer with local state"
```

---

### Task 3: HomePage hero rewrite + delete TaskComposer

**Files:**
- Rewrite: `src/components/HomePage.tsx`
- Delete: `src/components/home/TaskComposer.tsx`

**Interfaces:**
- Consumes: `HomeComposer` (Task 2); store `projects`, `activeProjectId`, `addProject`, `openThread`, `setActiveProject`; `usePrefsStore`, `pickDirectory`, `formatRelativeTime`.
- Produces: the home hero. No exported API change (`HomePage` stays the default home body).

- [ ] **Step 1: Rewrite HomePage.tsx**

Replace the entire file with the hero. It keeps the existing target-project resolution and recents logic, drops the `UsageDashboard`/`TaskComposer`, and adds the watermark, title, and project+branch header:

```tsx
import { useMemo, useState } from "react";
import { Check, ChevronDown, FolderPlus, GitBranch, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HomeComposer } from "@/components/home/HomeComposer";
import { useSessionStore } from "@/state/store";
import { usePrefsStore } from "@/state/prefs";
import { pickDirectory } from "@/lib/ipc";
import { cn, formatRelativeTime } from "@/lib/utils";

// The home screen shown when no thread panel is open and the body is not the
// fleet/usage view (HOY-264). A clean "start a new task" hero built on the real
// composer; usage stats live in their own Usage view.
const MAX_RECENTS = 6;

export function HomePage() {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const addProject = useSessionStore((s) => s.addProject);
  const openThread = useSessionStore((s) => s.openThread);
  const setActiveProject = useSessionStore((s) => s.setActiveProject);

  const [picked, setPicked] = useState<string | null>(null);

  const recents = useMemo(() => {
    const rows = projects.flatMap((p) =>
      p.threads
        .filter((t) => !t.archived)
        .map((t) => ({ thread: t, project: p })),
    );
    rows.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    return rows.slice(0, MAX_RECENTS);
  }, [projects]);

  const exists = (id: string | null) =>
    !!id && projects.some((p) => p.id === id);

  const targetProjectId =
    (exists(picked) ? picked : null) ??
    (exists(activeProjectId) ? activeProjectId : null) ??
    recents[0]?.project.id ??
    projects[0]?.id ??
    null;

  const targetProject = projects.find((p) => p.id === targetProjectId) ?? null;

  async function handleOpenProject() {
    const dir = await pickDirectory(
      usePrefsStore.getState().defaultProjectDir || undefined,
    );
    if (dir) addProject(dir);
  }

  const hasTarget = !!targetProject && !!targetProjectId;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      {/* Faint brand watermark behind the hero. */}
      <Sparkle
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-16 size-40 -translate-x-1/2 text-foreground/[0.03]"
      />

      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-8 py-16">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-foreground">
          {hasTarget
            ? `Start a new task in ${targetProject.name}`
            : "Start a new task"}
        </h1>

        {hasTarget ? (
          <div className="w-full">
            {/* Composer header: project pill (functional) + branch pill (mock). */}
            <div className="flex items-center gap-3 border border-b-0 border-border bg-card px-3 py-2 text-xs">
              {projects.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="inline-flex items-center gap-1.5 text-foreground">
                      <span className="max-w-[12rem] truncate">
                        {targetProject.name}
                      </span>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-52">
                    <DropdownMenuLabel>Project</DropdownMenuLabel>
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => {
                          setPicked(p.id);
                          setActiveProject(p.id);
                        }}
                      >
                        <Check
                          className={cn(
                            "size-4",
                            p.id === targetProjectId ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="truncate">{p.name}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void handleOpenProject()}>
                      <FolderPlus className="size-4" />
                      Open project...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="text-foreground">{targetProject.name}</span>
              )}

              {/* Mocked branch pill: git switching is not wired (HOY-264). */}
              <span
                className="inline-flex items-center gap-1.5 text-muted-foreground"
                title="Branch switching is not available yet"
              >
                <GitBranch className="size-3.5" />
                main
                <ChevronDown className="size-3.5" />
              </span>
            </div>

            <HomeComposer
              projectId={targetProjectId}
              projectPath={targetProject.path ?? null}
            />

            {recents.length > 0 && (
              <div className="mt-8 space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Recent
                </p>
                <div className="divide-y divide-border border border-border">
                  {recents.map(({ thread, project }) => (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => openThread(thread.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                    >
                      <Sparkle className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {thread.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {project.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatRelativeTime(thread.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <p className="max-w-md text-center text-sm text-muted-foreground">
              Open a project directory to start. Each project holds its own
              threads, and every thread is a conversation with the agent running
              in that working directory.
            </p>
            <Button onClick={() => void handleOpenProject()}>
              <FolderPlus className="size-4" />
              Open project
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Delete the stub composer**

```bash
git rm apps/desktop/src/components/home/TaskComposer.tsx
```

- [ ] **Step 3: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean. Expected: no remaining references to `TaskComposer` (HomePage no longer imports it) or `UsageDashboard` from HomePage.

```bash
cd /home/acidtib/Code/hoy
git add apps/desktop/src/components/HomePage.tsx
git commit -m "HOY-264: rewrite home as a start-a-task hero, drop stub composer"
```

---

### Task 4: Usage view + desktop-width dashboard layout

**Files:**
- Create: `src/components/UsageView.tsx`
- Modify: `src/components/home/UsageDashboard.tsx`
- Modify: `src/components/home/ActivityHeatmap.tsx`

**Interfaces:**
- Consumes: existing `UsageDashboard` (self-loads via `refreshUsage()` on mount).
- Produces: `<UsageView />` (default export not needed; named export `UsageView`).

- [ ] **Step 1: Create UsageView.tsx**

```tsx
import { UsageDashboard } from "@/components/home/UsageDashboard";

// Full-screen Usage view (HOY-264), rendered by App as the "usage" bodyView.
// Gives the dashboard the whole canvas; width-constrained for readability.
export function UsageView() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <UsageDashboard />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Widen the dashboard layout**

In `src/components/home/UsageDashboard.tsx`, replace the two stat-card rows with a single 6-up row and put the trend + models side by side. Find the block that renders the two `<div className="grid ...">` card groups and the `Daily tokens` / `Models` sections, and replace them so the return body reads:

```tsx
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Usage</h2>
        <RangeSwitch value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Tokens" value={formatTokens(v.totals.tokens)} />
        <StatCard label="Sessions" value={String(v.totals.sessions)} />
        <StatCard label="Messages" value={String(v.totals.messages)} />
        <StatCard label="Active days" value={String(v.totals.activeDays)} />
        <StatCard
          label="Current streak"
          value={`${v.streaks.current}d`}
          sub={`Longest ${v.streaks.longest}d`}
        />
        <StatCard label="Peak hour" value={v.peak != null ? formatHour(v.peak) : "-"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Daily tokens</p>
          <TokenTrendChart days={v.days} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Models</p>
          <ModelRanking rows={v.models} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Activity</p>
        <ActivityHeatmap days={report.days} />
      </div>
    </section>
  );
```

Leave the loading skeleton, the empty state, the `view`/`useMemo` block, and `formatHour` above the return unchanged.

- [ ] **Step 3: Make the heatmap fill the width with no scroll**

In `src/components/home/ActivityHeatmap.tsx`, replace the outer grid and cells so the 53 columns flex to fill the container and cells are square, with no horizontal scroll:

```tsx
  return (
    <div className="flex w-full gap-[2px]">
      {grid.map((col, ci) => (
        <div key={ci} className="flex flex-1 flex-col gap-[2px]">
          {col.map((cell) => {
            const ratio = cell.tokens > 0 ? 0.2 + 0.8 * (cell.tokens / max) : 0;
            return (
              <div
                key={cell.date}
                title={`${cell.date}: ${formatTokens(cell.tokens)} tokens`}
                className="aspect-square w-full border border-border/40 bg-brand"
                style={{
                  opacity: ratio || undefined,
                  backgroundColor: cell.tokens > 0 ? undefined : "transparent",
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
```

(Remove the old `overflow-x-auto` container and the fixed `size-2.5 shrink-0` cell sizing.)

- [ ] **Step 4: Typecheck and commit**

Run: `cd apps/desktop && bun run check:ts` -> clean. `bun test` -> 164 still pass (dashboard has no unit tests; derivations untouched).

```bash
cd /home/acidtib/Code/hoy
git add apps/desktop/src/components/UsageView.tsx apps/desktop/src/components/home/UsageDashboard.tsx apps/desktop/src/components/home/ActivityHeatmap.tsx
git commit -m "HOY-264: add full-width Usage view and no-scroll heatmap"
```

---

### Task 5: Route the Usage view (bodyView) + footer toggle + live-verify

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/ContextBar.tsx`

**Interfaces:**
- Consumes: `UsageView` (Task 4); store `bodyView`/`setBodyView`.
- Produces: `bodyView` value `"usage"`; a footer toggle in `ContextBar`.

- [ ] **Step 1: Widen the bodyView type**

In `src/state/store.ts`, change both occurrences (state field ~line 285 and action signature ~line 409):

```ts
  bodyView: "panels" | "fleet" | "usage";
```
```ts
  setBodyView: (view: "panels" | "fleet" | "usage") => void;
```

The initial value (`bodyView: "panels"`) and `setBodyView` implementation stay as-is.

- [ ] **Step 2: Render UsageView in App**

In `src/App.tsx`: add the import `import { UsageView } from "@/components/UsageView";`, then change the body switch (around line 181) so usage takes precedence:

```tsx
              {bodyView === "usage" ? (
                <UsageView />
              ) : bodyView === "fleet" ? (
                <FleetBoard />
              ) : panels.length === 0 ? (
                <HomePage />
              ) : (
```

Leave the rest of the panels branch unchanged.

- [ ] **Step 3: Add the footer toggle next to the fleet toggle**

In `src/components/ContextBar.tsx`: add `BarChart3` to the `lucide-react` import. In the bottom-right cell (the `<div className="flex shrink-0 items-center border-l border-border px-1.5">` that holds the fleet `FooterIconButton`, around line 118), add the Usage toggle immediately BEFORE the fleet button so it sits to its left:

```tsx
      <div className="flex shrink-0 items-center border-l border-border px-1.5">
        <FooterIconButton
          label={bodyView === "usage" ? "Show Panels" : "Show Usage"}
          onClick={() => setBodyView(bodyView === "usage" ? "panels" : "usage")}
          active={bodyView === "usage"}
        >
          <BarChart3 className="size-4" />
        </FooterIconButton>
        <FooterIconButton
          label={bodyView === "fleet" ? "Show Panels" : "Show FleetView"}
          onClick={() => setBodyView(bodyView === "fleet" ? "panels" : "fleet")}
          active={bodyView === "fleet"}
          activeClassName="text-agent"
        >
          <Sparkle className="size-4" />
        </FooterIconButton>
      </div>
```

- [ ] **Step 4: Gate**

Run: `cd apps/desktop && bun run check` (tsc + cargo + clippy + fmt) and `bun test`.
Expected: all green; 164 + 2 (`startThread`) tests pass.

- [ ] **Step 5: Live-verify in the dev app**

If the dev app is not running, start it: `cd apps/desktop && bun run tauri:dev` (uses `~/.hoyd`). Wait for the window (`pgrep -x hoy-desktop`).

Using the Tauri MCP driver (port 9223), screenshot and verify:
1. Home shows the hero: watermark, "Start a new task in {project}", the project pill + mocked branch pill header, the REAL composer (model selector, permission-mode pill, `+`, `@`, `/`, send), and recents beneath. It uses the centered hero layout, not the old cramped column.
2. Type a task and press Enter: a new thread is created and starts streaming (session spawns). Confirm the chosen model/permission carried over.
3. Open home, do not type, navigate away (open a thread, come back): no phantom empty thread was created by merely viewing home.
4. Click the bar-chart icon in the bottom-right footer (left of the fleet Sparkle): the full-width Usage view opens; the activity heatmap shows a full year with NO horizontal scroll; cards are in one row; trend + models are side by side. Click it again (or the fleet icon) to return.
5. Never point the dev app at production `~/.hoy`.

Screenshot the hero and the Usage view.

- [ ] **Step 6: Commit**

```bash
cd /home/acidtib/Code/hoy
git add apps/desktop/src/state/store.ts apps/desktop/src/App.tsx apps/desktop/src/components/ContextBar.tsx
git commit -m "HOY-264: route the Usage view with a footer toggle"
```

---

## Self-Review

**Spec coverage (HOY-264):**
- Clean hero home (watermark, title, real composer, project + mocked branch pill, recents) -> Tasks 2, 3.
- Real composer reuse -> Task 2 (`HomeComposer` feeds `Composer.tsx`).
- `startThread` create-and-send, no phantom threads -> Task 1 (+ live-verify step 3 in Task 5).
- Usage as a dedicated full-screen view -> Task 4 (`UsageView`) + Task 5 (routing).
- Footer toggle next to the fleet toggle -> Task 5 Step 3.
- Full-width dashboard, full-year heatmap no scroll -> Task 4 Steps 2-3.
- `TaskComposer` deleted -> Task 3 Step 2.
- Pipeline untouched (`usage_stats.rs`, `get_usage_stats`, `usage.ts`) -> not modified by any task.
- Store test for `startThread` -> Task 1.

**Placeholder scan:** none. Every code step carries complete code.

**Type consistency:** `startThread(projectId, message, { model, permissionMode, thinkingLevel, images })` is identical in the Task 1 interface, the Task 1 implementation, and the Task 2 call site. `bodyView` is `"panels" | "fleet" | "usage"` in the store, App switch, and ContextBar toggle. `HomeComposer` props (`projectId: string`, `projectPath: string | null`) match the Task 3 call site. `Composer` props match its interface at Composer.tsx:215-258 (`onChange: (v:string)=>void`, `onSelectMode?: (m:PermissionMode)=>void`, `onSelectThinking: (l:ThinkingLevel)=>void`, `projectPath?: string | null`).

**Open verification during execution:** confirm the `modelSupportsImages` (from `@/lib/types`) and `fileToImageAttachment` (from `@/lib/images`) import paths; confirm `ImageAttachment.content` is the `ImageContent` submitPrompt expects (it is, per ThreadView.tsx:230 `attachments.map((a) => a.content)`).
