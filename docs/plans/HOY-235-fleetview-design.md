# HOY-235: FleetView multi-agent panel, design

Phase 4 of the subagent infrastructure (HOY-231/233/236/245). Ticket:
https://linear.app/hoychat/issue/HOY-235

## Problem

The panel strip and the sidebar's one-level child nesting cannot represent a
fleet of agents at scale: no live status/tool/token view across many agents,
no recursive tree (HOY-245 lifts the depth cap this quarter), and no way to
steer/stop an agent without first opening its panel. Once HOY-246 turns off
auto-open, spawned children stop announcing themselves as panels at all;
FleetView must be a surface good enough to replace that.

## Decision: hybrid, per the mockup's own footer note

Mockup (both options + hybrid note, built in Hoy's real tokens):
https://claude.ai/code/artifact/1ba53339-3f12-425b-8d2c-1557c56d833c

- **FleetRail** (Option B): a third `sidebarView` mode ("fleet"), always-on,
  compact, live. Toggled from the footer (ContextBar) next to the existing
  history-clock toggle, same interaction pattern already shipped.
- **FleetBoard** (Option A): a full-body dashboard, toggled in from a header
  button inside FleetRail ("expand fleet"). Same underlying data/selectors,
  denser rows, whole-fleet-at-a-glance.
- Two zoom levels of one recursive data model, exactly as the mockup's footer
  proposes. Neither replaces the panel strip; both are additive watch/control
  surfaces over the existing thread tree.

## Simplification vs. the mockup (deliberate, noted for review)

The mockup's Option B renders a bespoke transcript+steer detail pane in the
body. That duplicates ThreadView (transcript rendering, tool blocks, approval
cards, composer) for no functional gain: the app already has a panel strip.
**FleetRail's "Open" action opens/focuses the thread as a normal panel**
(`openThread`, existing HOY-231 action) instead of a second transcript
renderer. This is a net simplification, not a scope cut: every mockup
capability (drill into one agent, see its transcript, steer it) is still
reachable, through infrastructure that already exists and is already tested.

Steer itself, per the ticket ("steer boxes need NO new backend"), gets a
minimal **inline** control on FleetRail/FleetBoard rows (see below) so a user
never has to open a panel just to redirect a running agent; that is the one
piece of Option B's body detail that IS worth a small dedicated UI, because
it is the one action that benefits from staying inline.

## Data model: fleet selectors (pure, testable, no Tauri imports)

New module `apps/desktop/src/state/fleet.ts`, sibling to `delivery.ts` and
built the same way (pure functions over `Project[]` + the live slices the
store already carries; unit-testable with `bun test`, no Tauri import).

```ts
export type FleetStatus = "running" | "queued" | "done" | "error";

// A fleet = a root (non-subagent) thread that has spawned at least one
// descendant. Threads with no descendants are not fleets; they render
// nowhere in FleetView (empty-fleet threads are just ordinary threads).
export function fleetRoots(projects: Project[]): Thread[]

// thread.id + every descendant (root first, depth-first), for one fleet.
// Reuses HOY-245's descendantThreadIdsOf; this just resolves ids -> Threads
// and keeps the root at index 0.
export function fleetMembers(projects: Project[], rootId: string): Thread[]

// Status priority: running beats a stale error (a fresh run in flight
// supersedes an error left over from a prior turn), error beats queued,
// queued beats done. `done` is the resting state for any fleet member that
// isn't currently running/queued/erroring (covers a root between turns,
// same as an idle thread).
export function fleetStatus(
  threadId: string,
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): FleetStatus

// Sum of stats[id].tokens.total / .cost across `memberIds`, skipping ids with
// no stats yet (never run). Returns 0/0 for an all-null set, not NaN.
export function fleetRollup(
  memberIds: string[],
  stats: Record<string, SessionStats | null>,
): { tokens: number; cost: number }

// Per-status counts across `memberIds`, for the dashboard's top rollup bar.
export function fleetStatusCounts(
  memberIds: string[],
  streaming: Record<string, boolean>,
  agentQueue: string[],
  threadErrors: Record<string, string | null>,
): Record<FleetStatus, number>
```

`fleetStatus`/`fleetRollup`/`fleetStatusCounts` take the live records as
arguments rather than reading the store directly, matching `delivery.ts`'s
existing pattern (pure core, side-effectful wiring stays in components via
`useSessionStore` selectors). This keeps the module unit-testable exactly
like HOY-245's `threadDepth`/`descendantThreadIdsOf`.

"Current tool" (shown per running row) is not a new field: it is derived at
render time from `turns[id]`'s last assistant turn's last `tool` block where
`running === true` (the same shape ThreadView already renders tool blocks
from). A tiny selector `currentTool(turns: Turn[]): string | null` lives in
`fleet.ts` alongside the others, same testability rationale.

## Store additions (`apps/desktop/src/state/store.ts`)

- `sidebarView: "projects" | "history" | "fleet"` (extend the existing union;
  `setSidebarView` already takes the full union so no signature change).
- `bodyView: "panels" | "fleet"`, default `"panels"`, plus `setBodyView`.
  Read by `App.tsx` to decide whether the main body renders the existing
  panel-strip/HomePage or `<FleetBoard />`. A node's "Open" action in either
  surface calls `openThread(id)` **and** `setBodyView("panels")` explicitly
  in the click handler; `openThread` itself stays unaware of body-view
  state, consistent with it being a plain thread action used from many call
  sites (sidebar, history, composer @ picker, subagent spawn).
- No other store changes. Every other piece of state FleetView needs
  (`streaming`, `agentQueue`, `stats`, `threadErrors`, `turns`, `projects`)
  already exists and is already populated independent of whether a panel is
  open (confirmed by reading `startChildRun`/the `done` handler in
  store.ts: `refreshStats` and turn/streaming updates are keyed by threadId
  and run unconditionally, not gated on `panels`). This is what makes
  HOY-246 (auto-open off) safe: FleetView's data source does not depend on a
  panel ever having existed.

## Actions, by node status

| status  | actions              | wiring |
|---------|-----------------------|--------|
| running | Open, Steer, Stop     | `openThread`+`setBodyView`, inline steer box, `submitPrompt(id, text, undefined, "steer")`, `stopStreaming(id)` |
| queued  | Cancel                | `requestTeardown("archive", id)`; already handles a never-started queued child (HOY-245 Task 5/6 purge covers queue removal) |
| done    | Open                  | `openThread`+`setBodyView` |
| error   | Open                  | `openThread`+`setBodyView` (see the error/thread banner in the panel; no separate retry affordance, resubmitting from the panel is the existing recovery path) |

Steer is scoped to `running` rows only (matches the ticket: "steer a running
agent"; a queued child has no session yet, a done/errored one isn't
streaming so there is nothing to steer into). The inline control is a single
text input revealed by clicking "Steer", collapsed on submit/blur/Escape,
not a second composer, just `submitPrompt` wired directly by threadId
exactly like the pure selectors above are wired directly by threadId,
without going through ThreadView.

## Component structure

```
apps/desktop/src/state/fleet.ts          # pure selectors (see above)
apps/desktop/src/components/fleet/
  FleetTree.tsx                          # recursive row renderer, shared by
                                          # both surfaces via a `dense` prop
  FleetRail.tsx                          # Option B: sidebarView === "fleet"
  FleetBoard.tsx                         # Option A: bodyView === "fleet"
```

`FleetTree` is the one piece of real sharing: both surfaces walk the same
recursive parent/children structure with the same indentation-by-depth and
connector-line rendering (mirrors `.kids`/`.rkids` in the mockup CSS). A
`dense: boolean` prop switches which columns render (rail: status dot + name
+ tokens; board: status dot + name + current tool + tokens + actions) so the
recursive walk is written once. This is the right amount of abstraction:
genuinely identical tree-walking logic, thin content variance, not a
premature generalization.

- **FleetRail**: rendered in `App.tsx`'s sidebar slot when
  `sidebarView === "fleet"` (mirrors the existing
  `sidebarView === "history" ? <ThreadHistory /> : <Sidebar />` ternary,
  extended to a 3-way). Header shows total agent/live counts and an "expand"
  button (`setBodyView("fleet")`). Body groups by fleet root (one heading per
  fleet name), each rendering `<FleetTree dense rootId={...} />`. Empty state
  ("No agents running") when `fleetRoots(projects)` is empty, per ticket
  scope ("only render when there is a fleet", interpreted as: the toggle is
  always available, like Clock, but the panel's content is an empty state
  rather than hidden entirely, consistent with ThreadHistory's own empty
  state pattern).
- **FleetBoard**: rendered in `App.tsx`'s body slot when
  `bodyView === "fleet"`, replacing the `panels.length === 0 ? <HomePage />
  : <panel strip>` branch with a third branch checked first. Top bar shows
  the aggregate rollup (`fleetStatusCounts`/`fleetRollup` across every
  fleet's members) plus a "Back to panels" control (`setBodyView("panels")`).
  Below it, one card per fleet root (`fleetRoots(projects)`), each a
  `<FleetTree dense={false} rootId={...} />` with the fuller row.

## ContextBar wiring

One more `FooterIconButton` beside the existing Clock toggle, using the
Sparkle icon already used for agent identity (teal `text-agent` when active,
matching the `active ? "text-brand" : ...` pattern but with the agent color
since this is specifically the agent-fleet surface, not a brand navigation
state). `onClick` toggles `sidebarView` between `"fleet"` and `"projects"`,
same shape as the existing history toggle.

## Non-goals / follow-ups

- No new backend/IPC. Every action reuses an existing store action.
- No timestamps beyond what `Thread.updatedAt` already carries; the mockup's
  "started Nm ago" is dropped, rows show "last activity" via the existing
  `formatRelativeTime`, not a fabricated start time (no per-turn timestamp
  exists to source it from). Follow-up: add turn timestamps if a real
  "elapsed" figure is wanted later.
- FleetBoard/FleetRail are read/control surfaces; they do not add new
  archive/delete affordances beyond Cancel (queued), the existing sidebar
  keeps that responsibility.
- HOY-246 (auto-open opt-in) ships as its own follow-on ticket per the Wave 3
  order, immediately after this one; FleetView does not gate on it landing
  first (both directions already verified independent above).
