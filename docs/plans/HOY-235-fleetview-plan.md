# HOY-235: FleetView SDD plan

Design: docs/plans/HOY-235-fleetview-design.md. Read it first; this plan
assumes its decisions (hybrid surface, FleetTree sharing, action table,
store additions) without repeating the rationale.

## Global constraints (every task)

- No emojis, no em-dashes (`--`) anywhere in code/comments/docs/commits. An
  ASCII `--` inside a string literal (e.g. a label) is fine.
- Plain commit messages, `HOY-235:` prefix, no Co-Authored-By trailer.
- No new runtime deps.
- `packages/sidecar` is untouched by this ticket; no rebuild needed.
- Match existing conventions: `cn()` for class composition, `lucide-react`
  icons, `Tooltip`/`TooltipContent` wrapping for icon buttons, the
  `--agent`/`text-agent` teal identity for anything fleet-related (HOY-236).
- Run `bun run check:ts` and, where a task touches `fleet.ts`, `bun test`
  after each task.
- Each task is a fresh implementer subagent + a fresh reviewer subagent
  (per-task review). Whole-branch review happens once, after Task 4.

## Task 1: pure fleet selectors (`apps/desktop/src/state/fleet.ts`)

**Files**: new `apps/desktop/src/state/fleet.ts`, new
`apps/desktop/src/state/fleet.test.ts`.

**No Tauri imports** (only `import type` for `Project`/`Thread`/`Turn`/
`SessionStats` from `../lib/types`), so `bun test` can load it standalone,
same rule `delivery.ts` follows.

**Interfaces** (exact shapes from the design doc):

```ts
export type FleetStatus = "running" | "queued" | "done" | "error";

export function fleetRoots(projects: Project[]): Thread[]
export function fleetMembers(projects: Project[], rootId: string): Thread[]
export function fleetStatus(
  threadId: string,
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): FleetStatus
export function fleetRollup(
  memberIds: string[],
  stats: Record<string, import("../lib/types").SessionStats | null>,
): { tokens: number; cost: number }
export function fleetStatusCounts(
  memberIds: string[],
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): Record<FleetStatus, number>
export function currentTool(turns: import("../lib/types").Turn[]): string | null
```

**Steps**:
1. `fleetRoots`: filter `projects.flatMap(p => p.threads)` to
   `!t.parentThreadId && childThreadIdsOf(projects, t.id).length > 0`
   (import `childThreadIdsOf` from `./delivery`; a single direct child is
   enough to qualify, depth >= 2 is not required).
2. `fleetMembers`: `[root, ...descendantThreadIdsOf(projects, rootId).map(id
   => byId.get(id))]`, filtering out any id that fails to resolve (defensive,
   mirrors `delivery.ts`'s guarded lookups). Import `descendantThreadIdsOf`
   from `./delivery`.
3. `fleetStatus`: priority `running > error > queued > done`.
   `streaming[id]` true -> `"running"` (a fresh run in flight supersedes a
   stale error from a prior turn). Else `threadErrors[id]` truthy ->
   `"error"`. Else `agentQueue.includes(id)` -> `"queued"`. Else `"done"`.
4. `fleetRollup`: `memberIds.reduce`, skip ids with `stats[id] == null`, sum
   `stats[id]!.tokens.total` and `stats[id]!.cost`. Empty/all-null input
   returns `{ tokens: 0, cost: 0 }`.
5. `fleetStatusCounts`: `{ running: 0, queued: 0, done: 0, error: 0 }`
   seeded, then one pass over `memberIds` incrementing via `fleetStatus`.
6. `currentTool`: find the last `role === "assistant"` turn in `turns`; if
   `streaming` is false on it return `null`; else scan `blocks` for the last
   `{ kind: "tool" }` block where `tool.running === true`, return
   `tool.title || tool.name`; no running tool block -> `null`.
7. Tests (mirror `delivery.test.ts`'s style): a small fixture tree (root +
   2 children, one with a grandchild), covering: fleetRoots excludes
   childless roots and excludes non-root threads; fleetMembers includes the
   grandchild; fleetStatus priority ordering (especially the
   running-beats-stale-error case); fleetRollup sums correctly and treats
   missing stats as 0, not NaN; fleetStatusCounts sums to `memberIds.length`;
   currentTool returns null for a non-streaming turn and the right tool name
   for a running one with multiple tool blocks (picks the last running one).

**Verification**: `bun test apps/desktop/src/state/fleet.test.ts`, then
`bun run check:ts`.

## Task 2: store additions (`apps/desktop/src/state/store.ts`)

**Files**: `apps/desktop/src/state/store.ts` only.

**Steps**:
1. Widen the `sidebarView` field type from `"projects" | "history"` to
   `"projects" | "history" | "fleet"` (the state field, its initial value
   stays `"projects"`, and the `setSidebarView` action signature: check
   whether it is already typed against the union or against a narrower
   literal, widen whichever needs it so `"fleet"` type-checks).
2. Add `bodyView: "panels" | "fleet"` to the store interface and initial
   state (`"panels"`), plus `setBodyView: (view: "panels" | "fleet") =>
   void` implemented as `set({ bodyView: view })`, placed next to
   `setSidebarView`.
3. Do NOT touch `openThread`, `submitPrompt`, `stopStreaming`,
   `requestTeardown`, or any other existing action; this task is additive
   only, per the design doc's explicit call that `openThread` stays
   body-view-unaware.

**Verification**: `bun run check:ts`. No behavior changes yet (nothing reads
`bodyView` or `"fleet"` sidebarView until Tasks 3/4), so no runtime
verification is meaningful for this task alone.

## Task 3: FleetTree + FleetRail (Option B) + ContextBar toggle

**Files**: new `apps/desktop/src/components/fleet/FleetTree.tsx`, new
`apps/desktop/src/components/fleet/FleetRail.tsx`, edit
`apps/desktop/src/App.tsx`, edit `apps/desktop/src/components/ContextBar.tsx`.

**FleetTree.tsx**:
- Props: `{ rootId: string; dense: boolean }`.
- Reads `projects`, `streaming`, `agentQueue`, `stats`, `threadErrors`,
  `turns` via `useSessionStore` selectors; computes `fleetMembers(projects,
  rootId)` (memoized with `useMemo` keyed on `projects`/`rootId`), then
  builds a `parentThreadId -> children[]` map from those members only (a
  fleet subtree, not the whole workspace) and renders recursively starting
  at the root, indenting each level (reuse the same `pl-*`/border-left
  connector pattern `Sidebar.tsx`'s `ThreadRow`/`kids` nesting already uses,
  do not invent new spacing tokens).
- Each row: status dot (color per `FleetStatus`: running=`text-agent` with a
  pulse via `animate-pulse` on the dot, queued=muted outline, done=a
  success/`--ok`-equivalent token already in the theme, check
  `globals.css`/tailwind config for the existing success color used
  elsewhere before inventing one, error=`text-destructive`), Sparkle icon
  (teal, matching `Sidebar.tsx`'s agent rows), thread title, and:
  - `dense === true` (rail): trailing token count only (`formatTokens` from
    `@/lib/utils`, already used in ContextBar).
  - `dense === false` (board): trailing current-tool chip
    (`currentTool(turns[id])`, `font-mono` pill like the mockup's `.tool`),
    token count, and the action buttons from the design doc's action table,
    shown on hover (`opacity-0 group-hover:opacity-100`, same pattern as
    `Sidebar.tsx` row actions).
- "Steer" (running rows, dense=false only; the rail has no room for it,
  matches the design doc's "one piece of Option B's body worth inline UI"
  being scoped to the fuller row) toggles a local `useState` boolean revealing
  a single `<input>` + send button in place of the actions row; Enter or the
  button calls `submitPrompt(id, value, undefined, "steer")` then collapses
  and clears; Escape or blur (without submit) just collapses.
- "Stop" calls `stopStreaming(id)`. "Cancel" (queued rows) calls
  `requestTeardown("archive", id)`. "Open" calls `openThread(id)` then
  `setBodyView("panels")`.
- Row click (not on an action button) also opens the thread, same as
  clicking "Open", matching `Sidebar.tsx`'s row-is-clickable convention.

**FleetRail.tsx**:
- Mirrors `SidebarShell` wrapping (reuse `SidebarShell` from `Sidebar.tsx`
  by importing it, do not duplicate the width/resize-handle chrome).
- Header: "Fleet" label, live/total counts (`fleetStatusCounts` summed
  across every `fleetRoots(projects)`'s `fleetMembers`), and an "expand"
  icon button (`setBodyView("fleet")`), tooltip "Expand fleet view".
- Body: `fleetRoots(projects)` mapped to a heading (fleet root's title) +
  `<FleetTree dense rootId={root.id} />`; empty state "No agents running"
  (centered, muted, mirrors `Sidebar.tsx`'s `SidebarEmptyState` tone but no
  action button, there is nothing to create here) when `fleetRoots` is
  empty.

**App.tsx**: extend the sidebar ternary
(`sidebarView === "history" ? <ThreadHistory /> : <Sidebar />`) to a 3-way:
`"history" -> ThreadHistory`, `"fleet" -> FleetRail`, else `Sidebar`.

**ContextBar.tsx**: add one more `FooterIconButton` after the existing
Clock toggle, using the `Sparkle` icon (import from `lucide-react`, already
used elsewhere), `label`/`active` mirroring the Clock button's pattern but
toggling `sidebarView` between `"fleet"` and `"projects"`, and
`active ? "text-agent" : "text-muted-foreground"` in place of the Clock
button's brand color (this button represents the agent-fleet surface, not a
brand navigation state; keep the color distinction deliberate, do not copy
`text-brand`).

**Verification**: `bun run check:ts`, then manual: `bun run tauri:dev`,
spawn a subagent (or two, nested), open the fleet rail via the new footer
toggle, confirm it lists the fleet with live status, click a running row's
name to open its panel, click Steer and send a message, click Stop.

## Task 4: FleetBoard (Option A) + App.tsx body wiring

**Files**: new `apps/desktop/src/components/fleet/FleetBoard.tsx`, edit
`apps/desktop/src/App.tsx`.

**FleetBoard.tsx**:
- Top bar: title "FleetView", a "Back" button (`setBodyView("panels")`,
  icon + label, placed where the mockup's back-out affordance would sit),
  and the aggregate rollup line: `fleetStatusCounts`/`fleetRollup` computed
  across the union of every `fleetRoots(projects)`'s `fleetMembers` (not
  per-fleet here, this is the whole-app total, mirrored in the mockup's
  `.rollup` bar). Format tokens with `formatTokens`, cost with the same
  `$X.XXXX`/`$X.XX` split ContextBar's `PanelStats` already uses (reuse
  that formatting logic; extract it to a shared helper in `@/lib/utils` only
  if duplicating the two-line ternary would be uglier than a one-line
  import; judgment call for the implementer, not a hard requirement).
- Body: scrollable list of fleet cards, one per `fleetRoots(projects)`
  entry: a bordered card with a header (root title, member count, that
  fleet's own `fleetRollup`) and `<FleetTree dense={false} rootId={root.id}
  />` beneath it. Empty state when there are no fleets (should be rare here
  since `bodyView` only reaches `"fleet"` via a deliberate click, but handle
  it: "No agents running" same as the rail).

**App.tsx**: in the body's `bodyRef` container, add a branch checked before
the existing `panels.length === 0 ? <HomePage /> : <panel strip>` ternary:
`bodyView === "fleet" ? <FleetBoard /> : (existing ternary)`. The
`ResizeObserver`/`bodyRef` measurement and the footer (`ContextBar`) stay
exactly as they are; `bodyView` only swaps what renders inside the existing
body container, it does not restructure the shell.

**Verification**: `bun run check:ts`, then manual: from the fleet rail's
expand button, confirm the board replaces the body (panel strip/HomePage
gone, sidebar and footer untouched), confirm the rollup numbers match what
the rail showed, click "Back" to confirm it returns to the panel strip
exactly as it was (no panel state lost), click a node's Open/Steer/Stop and
confirm each still works from the board.

## Whole-branch review (after Task 4)

Read `fleet.ts`, the store diff, and all three new components together.
Check specifically:
- No component reads Tauri/IPC directly; all fleet data flows through
  `useSessionStore` selectors and the pure `fleet.ts` functions, matching
  the rest of the codebase's separation.
- `FleetTree` is genuinely shared (both call sites pass `dense` and nothing
  else diverges in the recursive walk); if Task 3/4 implementers drifted
  into two near-duplicate trees, that is a finding to fix before merge, not
  a footnote.
- Steer/Stop/Cancel/Open all resolve to the exact existing store actions
  named in the design doc's action table; no new IPC calls anywhere.
- `openThread` and `submitPrompt` are unmodified (diff review, not just a
  claim).
- No emojis/em-dashes; commit messages `HOY-235:`-prefixed, no
  Co-Authored-By.
