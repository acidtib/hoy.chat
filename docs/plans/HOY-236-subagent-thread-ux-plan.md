# HOY-236 Subagent Thread UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-open a spawned subagent thread and give agent threads + their parents a shared teal color identity.

**Architecture:** Renderer-only. A new `--agent` design token (teal, distinct from the indigo brand which means "active"). Identity is derived from the already-persisted `parentThreadId` via pure helpers, applied to the sidebar row icon, the panel top edge, and the ThreadView header icon. `spawnChildThread` reuses the existing `openThread` path to auto-open the child.

**Tech Stack:** React + TypeScript, Tailwind v4 (`@theme inline` CSS-var-driven utilities), zustand store, bun test.

## Global Constraints

- No emojis, no em-dashes (`--`) anywhere: code, comments, docs, commits. Use a comma/semicolon or rewrite. (An ASCII double-hyphen inside an existing label string, e.g. "Subagent result -- type", is deliberate and stays.)
- Commit messages: plain, `HOY-236:` prefix, no Co-Authored-By trailer.
- No new dependencies. Never install the Vercel AI SDK or `@ai-sdk/*`.
- Code comments: facts/decisions/why only; no narration of what the code does.
- Renderer-only change. Do NOT touch `packages/sidecar`, so no sidecar rebuild is needed.
- All colors OKLCH. Square theme (`--radius: 0`); do not reintroduce rounding. No side-stripe accent borders (named DESIGN anti-pattern).
- Frontend/backend contract note: no `AgentEvent` or Rust changes in this ticket.

---

### Task 1: `--agent` design token

**Files:**
- Modify: `apps/desktop/src/index.css` (`@theme inline` map ~line 22; `:root` light ~line 100; `.dark` ~line 124)
- Modify: `apps/desktop/DESIGN.md` (color strategy note ~line 54)

**Interfaces:**
- Produces: Tailwind utilities `text-agent`, `border-agent`, `bg-agent` (and opacity variants like `border-agent/40`) backed by CSS var `--agent`. Consumed by Tasks 3-4 style call sites.

- [ ] **Step 1: Register the theme mapping.** In `apps/desktop/src/index.css`, in the `@theme inline` block, directly after the `--color-brand-foreground` line (~23), add:

```css
    --color-agent: var(--agent);
```

- [ ] **Step 2: Add the light value.** In the `:root` block, directly after the `--brand-foreground` line (~100), add:

```css
    --agent: oklch(0.58 0.13 195);
```

- [ ] **Step 3: Add the dark value.** In the `.dark` block, directly after the `--brand-foreground` line (~125), add:

```css
    --agent: oklch(0.72 0.12 195);
```

- [ ] **Step 4: Record the hue in DESIGN.md.** In `apps/desktop/DESIGN.md`, in the `### Strategy` paragraph (~line 54-60), append a sentence:

```markdown
A second reserved hue, `--agent` (teal, ~195), marks subagent threads and the threads running them (see HOY-236); it is the only non-brand identity hue and never fills large surfaces.
```

Also add a row to the Dark color table (after the `--brand-foreground` row):

```markdown
| `--agent` | `oklch(0.72 0.12 195)` | subagent/parent thread identity (teal) |
```

- [ ] **Step 5: Verify the build picks up the utility.** Run:

```bash
cd apps/desktop && bun run build 2>&1 | tail -5
```

Expected: build succeeds (Vite + tsc). The utility classes are validated for real in Task 4 when they are used; this step only confirms the token addition did not break the CSS build.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/index.css apps/desktop/DESIGN.md
git commit -m "HOY-236: add --agent identity token (teal)"
```

---

### Task 2: `isSubagentThread` pure helper + tests

**Files:**
- Modify: `apps/desktop/src/state/delivery.ts`
- Test: `apps/desktop/src/state/delivery.test.ts`

**Interfaces:**
- Consumes: `childThreadIdsOf(projects, parentId)` (already in `delivery.ts`).
- Produces:
  - `isSubagentThread(thread: { parentThreadId?: string | null }): boolean` - true when the thread was spawned by a parent.
  - (No new `hasSubagents` function; parent-role callers use `childThreadIdsOf(projects, id).length > 0` directly.)

- [ ] **Step 1: Write the failing test.** `apps/desktop/src/state/delivery.test.ts` already exists and imports `{ test, expect, beforeEach }` from `bun:test` and a list of helpers from `./delivery`. Match that style: add `isSubagentThread` to the existing `./delivery` import, add `import type { Project } from "../lib/types";` near the top, and append these tests at the end of the file:

```typescript
test("isSubagentThread is true when the thread has a parent", () => {
  expect(isSubagentThread({ parentThreadId: "t_parent" })).toBe(true);
});

test("isSubagentThread is false for a top-level thread", () => {
  expect(isSubagentThread({ parentThreadId: null })).toBe(false);
  expect(isSubagentThread({})).toBe(false);
});

test("childThreadIdsOf detects a parent's children", () => {
  const projects: Project[] = [
    {
      id: "p1",
      name: "p1",
      threads: [
        { id: "a", title: "a", updatedAt: 0, sessionId: null },
        { id: "b", title: "b", updatedAt: 0, sessionId: null, parentThreadId: "a" },
        { id: "c", title: "c", updatedAt: 0, sessionId: null },
      ],
    },
  ];
  expect(childThreadIdsOf(projects, "a")).toEqual(["b"]);
  expect(childThreadIdsOf(projects, "c")).toEqual([]);
});
```

Note: `childThreadIdsOf` is already imported in this file. If the `Project` literal above trips `tsc` on a missing required field, add the minimal fields `Project` requires (check `types.ts:389-396`); keep threads to the minimal `Thread` shape the type allows.

- [ ] **Step 2: Run the test, verify it fails.** Run:

```bash
cd apps/desktop && bun test src/state/delivery.test.ts 2>&1 | tail -20
```

Expected: FAIL - `isSubagentThread` is not exported / not a function.

- [ ] **Step 3: Implement the helper.** In `apps/desktop/src/state/delivery.ts`, after `shouldDeliverToParent` (~line 68), add:

```typescript
// A thread is a subagent thread iff it was spawned by a parent. Drives the
// agent color identity in the sidebar and panels (HOY-236). Parent-role
// detection uses childThreadIdsOf(projects, id).length > 0.
export function isSubagentThread(thread: {
  parentThreadId?: string | null;
}): boolean {
  return !!thread.parentThreadId;
}
```

- [ ] **Step 4: Run the test, verify it passes.** Run:

```bash
cd apps/desktop && bun test src/state/delivery.test.ts 2>&1 | tail -20
```

Expected: PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/state/delivery.ts apps/desktop/src/state/delivery.test.ts
git commit -m "HOY-236: isSubagentThread pure helper + tests"
```

---

### Task 3: Auto-open the spawned child

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (`spawnChildThread`, ~line 840)

**Interfaces:**
- Consumes: `get().openThread(id)` (store action, store.ts:521) - opens a panel, sets `activeThreadId`, focuses.
- Produces: no new exports; behavior change only.

This task has no unit test: `spawnChildThread` and `openThread` depend on Tauri `invoke` and the live sidecar, which are unavailable under bun test (renderer test debt, HOY-241). It is verified in the live-verify pass at the end of the plan. Keep the change minimal and self-evidently correct.

- [ ] **Step 1: Add the auto-open call.** In `apps/desktop/src/state/store.ts`, in `spawnChildThread`, the child is inserted into state by the `set((s) => ({ ... }))` block that seeds `turns[childId]` and `streaming` (ends ~line 840, right before `try {`). Immediately after that `set(...));` and before `try {`, insert:

```typescript
    // Auto-open the child so the user follows the run live instead of finding
    // it after the fact (HOY-236). The child is already in projects above, so
    // openThread's findThread resolves. FleetView (HOY-235) will later route
    // this to a consolidated view; the call site is unchanged.
    get().openThread(childId);
```

- [ ] **Step 2: Typecheck.** Run:

```bash
cd apps/desktop && bunx tsc --noEmit 2>&1 | tail -20
```

Expected: no new errors referencing `store.ts` / `spawnChildThread`.

- [ ] **Step 3: Confirm existing tests still pass.** Run:

```bash
cd apps/desktop && bun test 2>&1 | tail -15
```

Expected: PASS (no regression; this file has no direct unit test).

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/state/store.ts
git commit -m "HOY-236: auto-open spawned subagent thread"
```

---

### Task 4: Agent color identity across sidebar, panel edge, and header

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (`ProjectGroup` ~line 342-374 to pass a role flag; `ThreadRow` ~line 382-454)
- Modify: `apps/desktop/src/App.tsx` (panel top-border, ~line 170-205)
- Modify: `apps/desktop/src/components/ThreadView.tsx` (header Sparkle ~line 257-262; subagent-result card ~line 392-398)

**Interfaces:**
- Consumes: `isSubagentThread(thread)` and `childThreadIdsOf(projects, id)` from `state/delivery.ts` (Task 2); `text-agent` / `border-agent` utilities (Task 1).
- Produces: no new exports; presentational only.

This task is presentational; it is verified in the live-verify pass (screenshots), not by unit tests. Typecheck + build must pass at each commit.

- [ ] **Step 1: Sidebar - compute the agent role and tint the icon.** In `apps/desktop/src/components/Sidebar.tsx`:

  1. Add `isSubagentThread` to the import from `../state/delivery` (create the import if none exists; `childThreadIdsOf` may already be imported for other reasons - if not, import it too).
  2. In `ProjectGroup`, where each top-level `thread` is mapped (~line 344), the parent's children array `children` is already computed. Pass an `isAgent` prop to the parent `ThreadRow` = `children.length > 0`, and to each child `ThreadRow` pass `isAgent={true}`.

  Parent row (~line 351):

```tsx
                    <ThreadRow
                      thread={thread}
                      depth={0}
                      active={thread.id === activeThreadId}
                      open={openIds.has(thread.id)}
                      onSelect={() => onSelectThread(thread.id)}
                      childCount={children.length}
                      childrenOpen={childrenOpen}
                      onToggleChildren={() => toggleChildren(thread.id)}
                      isAgent={children.length > 0}
                    />
```

  Child row (~line 363):

```tsx
                        <ThreadRow
                          key={child.id}
                          thread={child}
                          depth={1}
                          active={child.id === activeThreadId}
                          open={openIds.has(child.id)}
                          onSelect={() => onSelectThread(child.id)}
                          isAgent
                        />
```

- [ ] **Step 2: Sidebar - consume the role in `ThreadRow`.** Add `isAgent` to the `ThreadRow` props type and destructure it (default `false`). Change the `Sparkle` className (~line 449-454) so an agent-role row is persistently teal; otherwise keep the existing brand-when-active rule:

```tsx
      <Sparkle
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          isAgent
            ? "text-agent"
            : active || open
              ? "text-brand"
              : "text-muted-foreground",
        )}
      />
```

Props type addition (~line 382-400): add `isAgent?: boolean;` and destructure `isAgent = false,`.

- [ ] **Step 3: Typecheck + commit the sidebar change.** Run:

```bash
cd apps/desktop && bunx tsc --noEmit 2>&1 | tail -10
```

Expected: no new errors. Then:

```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "HOY-236: teal agent identity on sidebar rows"
```

- [ ] **Step 4: App - agent-hue panel top edge.** In `apps/desktop/src/App.tsx`:

  1. Import the helpers and store selector needed to know a panel's role. The panels are `panels` (from the store) and `projects` (add a selector if not already read). Add near the other store reads: a `projects` value (via `useSessionStore((s) => s.projects)`; App.tsx does not read it yet), and `import { isSubagentThread, childThreadIdsOf } from "@/state/delivery";` (App.tsx uses the `@/` alias).
  2. Add a local helper inside the component, before the return:

```tsx
  const panelIsAgent = (panelId: string) => {
    const found = findThread(projects, panelId);
    if (!found) return false;
    return (
      isSubagentThread(found.thread) ||
      childThreadIdsOf(projects, panelId).length > 0
    );
  };
```

  `findThread` is exported from `store.ts` (line 2082) as `findThread(projects, id)` returning `{ project, thread } | undefined`. `App.tsx` does not import it yet; add it to the existing `@/state/store` import.

  3. Expanded panel border (~line 173-178) becomes:

```tsx
                      className={cn(
                        "flex min-h-0 flex-1 flex-col border-t-2",
                        panelIsAgent(expandedPanel.id)
                          ? expandedPanel.id === activeThreadId
                            ? "border-t-agent/80"
                            : "border-t-agent/40"
                          : expandedPanel.id === activeThreadId
                            ? "border-t-brand/70"
                            : "border-t-transparent",
                      )}
```

  4. Strip panel border (~line 199-204) becomes:

```tsx
                            className={cn(
                              "flex min-h-0 shrink-0 flex-col border-r border-t-2 border-r-border",
                              panelIsAgent(panel.id)
                                ? panel.id === activeThreadId
                                  ? "border-t-agent/80"
                                  : "border-t-agent/40"
                                : panel.id === activeThreadId
                                  ? "border-t-brand/70"
                                  : "border-t-transparent",
                            )}
```

- [ ] **Step 5: Typecheck + commit the App change.** Run:

```bash
cd apps/desktop && bunx tsc --noEmit 2>&1 | tail -10
```

Expected: no new errors. Then:

```bash
git add apps/desktop/src/App.tsx
git commit -m "HOY-236: teal agent identity on panel top edge"
```

- [ ] **Step 6: ThreadView - header icon + result card.** In `apps/desktop/src/components/ThreadView.tsx`:

  1. `ThreadView.tsx` already imports `findThread` (line 58) and reads `projects = useSessionStore((s) => s.projects)` (line 103), and already computes `findThread(projects, threadId)` inside a memo (line 146). Add `import { isSubagentThread, childThreadIdsOf } from "@/state/delivery";` (match the file's `@/`-alias import style).
  2. Compute a role boolean in the component body (place it after `projects` is in scope; reuse the existing `found` from the line 146 memo if it is accessible, otherwise recompute):

```tsx
  const threadIsAgent = (() => {
    const found = findThread(projects, threadId);
    if (!found) return false;
    return (
      isSubagentThread(found.thread) ||
      childThreadIdsOf(projects, threadId).length > 0
    );
  })();
```

  3. Header `Sparkle` (~line 257-262) becomes:

```tsx
          <Sparkle
            className={cn(
              "size-4 shrink-0",
              threadIsAgent
                ? "text-agent"
                : active
                  ? "text-brand"
                  : "text-muted-foreground",
            )}
          />
```

  4. Migrate the subagent-result card (~line 392-398) from brand to agent:

```tsx
                    <div
                      key={i}
                      className="rounded-md border border-agent/40 bg-agent/5 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-agent">
                        Subagent result{turn.subagent ? ` -- ${turn.subagent.type}` : ""}
                      </div>
```

- [ ] **Step 7: Typecheck + build.** Run:

```bash
cd apps/desktop && bunx tsc --noEmit 2>&1 | tail -10 && bun run build 2>&1 | tail -5
```

Expected: no errors; build succeeds. This confirms the `text-agent` / `border-agent` utilities resolve.

- [ ] **Step 8: Commit.**

```bash
git add apps/desktop/src/components/ThreadView.tsx
git commit -m "HOY-236: teal agent identity in ThreadView header + result card"
```

---

## Live-verify (after all tasks)

Not a task for a subagent; the orchestrator runs this.

1. `bun run tauri:dev` (dev app, hoyd namespace). Ensure `~/.hoyd/agent/auth.json` has a DeepSeek key (copy from `~/.hoy/agent/` if needed).
2. Drive via the tauri MCP bridge (`driver_session` on port 9223).
3. Start a thread on a DeepSeek model. Prompt it to spawn a subagent (e.g. "Use the Explore subagent to list the files in this directory").
4. Confirm and screenshot:
   - The child thread auto-opens as its own live panel (no manual expand needed).
   - The child sidebar row shows a teal `Sparkle`; the parent row (now with a child) shows a teal `Sparkle`.
   - The child panel and the parent panel both show a teal top edge (brighter on the active one).
   - After the child delivers, the parent's subagent-result card renders in teal.
5. Screenshot light mode too if quick (toggle `<html class="dark">` off via the bridge) to confirm the light `--agent` value reads.

## Self-review notes

- Spec coverage: auto-open (Task 3), child identity (Tasks 1/2/4), parent identity (Task 4 via `childThreadIdsOf`), one shared hue (Task 1), no persistence/Rust change (none present). All covered.
- The `findThread` export from `store.ts` is assumed; Task 4 Steps 4/6 give an inline-scan fallback if it is not exported, so the plan does not block on that assumption.
