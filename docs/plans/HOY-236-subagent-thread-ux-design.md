# Subagent thread UX: auto-open + agent/parent color identity (HOY-236) - design

Wave 2 of the "finish shipping subagents" burn-down. Follow-on UX for Phase 1
(HOY-231). Two independent, renderer-only changes: auto-open a spawned child
thread, and a shared color identity that marks agent threads and their parents.
No Rust, no sidecar, no persistence-schema changes. One branch
(`hoy-236-subagent-thread-ux`).

## Problem

When a parent spawns a child (`spawnChildThread`, store.ts:798), the child is
inserted into `project.threads`, seeded with a transcript, and streamed. But:

- **No auto-open.** `spawnChildThread` never calls `openThread`, so no panel
  opens and the child is not selected. The user only sees the run after manually
  expanding the parent in the sidebar and clicking the (collapsed-by-default)
  child row, by which point it has usually finished. Contrast `addThread`
  (store.ts:795), which opens the thread it creates.
- **No visual identity.** Every thread shares the single brand hue (indigo ~274).
  A subagent thread and its parent look identical to any other thread apart from
  sidebar nesting. There is no at-a-glance signal that a thread is an agent, or
  that a thread is running agents.

## Design

### Auto-open the spawned child

In `spawnChildThread`, after the child is inserted into state and its transcript
is seeded (store.ts:840), call `get().openThread(childId)`. This reuses the
existing open path: it adds a panel to the strip, sets `activeThreadId` to the
child, sets `activeProjectId`, and bumps the `focusRequest` nonce. The child is
already in `projects` at that point, so `openThread`'s `findThread` resolves.

**Multiple concurrent agents: open each.** The ticket leaves the choice open
(open each, or a fleet view). FleetView (HOY-235, Wave 3) is not built yet, and
the panel strip is already multi-panel by design (App.tsx:194). So each spawned
child opens as its own panel; N concurrent spawns produce N panels, the
last-spawned active, all visible in the horizontally-scrollable strip. When
FleetView lands it supersedes this with a consolidated view; the auto-open call
site stays the same (it just targets the fleet view instead).

**Focus-steal is acceptable here.** A parent only spawns a child while it is
mid-turn (it just called the agent tool), so the user is not typing in the
parent composer. Reusing `openThread` (which focuses the child composer) is
fine; a dedicated non-focusing variant is YAGNI.

`openThread` also fires `hydrateThread(childId)` in the background. A fresh child
has no `sessionFile`, so `hydrateThread` early-returns; harmless.

### Color identity: one shared `--agent` token

The ticket wants an agent thread to carry a distinct border color, and the
parent to carry the *same* color to mark it as running agents. So the identity
is **one hue shared by a family** (parent + its children), not a per-type
palette. Per-agent-type coloring is FleetView-era (HOY-235) and contradicts the
"same color" requirement when a parent has children of mixed types; YAGNI here.

The hue must be distinct from the brand indigo, because brand already means
"active" (`border-t-brand/70` active-panel edge, `text-brand` active icons). A
new semantic token:

- `--agent` (dark): `oklch(0.72 0.12 195)` - a cool teal, clearly separated from
  the indigo brand (~274) yet harmonious with the ~285 near-black surfaces.
- `--agent` (light): `oklch(0.58 0.13 195)`.
- Registered in the `@theme inline` map as `--color-agent: var(--agent)` so
  Tailwind emits `text-agent` / `border-agent` / `bg-agent` utilities.

Teal, not amber: amber is reserved for the site's beta/honesty signal
(PRODUCT/DESIGN); keeping desktop to indigo-brand + teal-agent avoids cross-app
signal collision. This is the app's second identity hue; DESIGN.md's "single
brand hue" strategy note is updated to record the reserved agent hue.

### Identity roles (pure helpers)

Two roles drive all styling, both derivable from already-persisted fields
(`parentThreadId`), so identity survives restart with no schema change:

- **child**: `isSubagentThread(thread)` = `!!thread.parentThreadId`.
- **parent**: `hasSubagents(projects, threadId)` = `childThreadIdsOf(...).length
  > 0` (reuses the existing HOY-238 helper).

`isSubagentThread` is a new pure helper in `state/delivery.ts` (alongside
`childThreadIdsOf`), unit-tested in `delivery.test.ts`.

**Parent marker keyed on "has a child thread", not "currently running a child".**
`completedAt` (the running/done signal) is deliberately not persisted (HOY-240),
so "currently running" cannot survive restart, whereas `parentThreadId` does. A
parent that spawned agents keeps the marker for the life of the thread family;
this reads as "this thread spawned agents", which is the useful signal. Tracking
live-vs-done per child is FleetView's job.

### Where the color applies

Both roles (child and parent) render the **same** teal treatment; the shared hue
is the family signal.

1. **Sidebar row** (`Sidebar.tsx` `ThreadRow`): the `Sparkle` icon is tinted
   `text-agent` **persistently** (not only when active/open) for any agent-role
   row, so agent threads and their parents read as teal at rest in the list.
   Normal rows keep the existing rule (brand when active/open, muted otherwise).
   No side-stripe border (a named anti-pattern); the tinted icon is the marker.

2. **Open panel top edge** (`App.tsx`): today the panel top border is
   `border-t-brand/70` when active, transparent otherwise. For agent-role panels
   the edge uses the agent hue and shows persistently: `border-t-agent/80` when
   active, `border-t-agent/40` when inactive. Normal panels are unchanged
   (`border-t-brand/70` active, transparent inactive). Hue encodes agent-ness;
   brightness still encodes active. Applies to both the strip and expanded paths.

3. **ThreadView header** (`ThreadView.tsx`): the header `Sparkle` follows the
   same rule as the sidebar (agent-role -> `text-agent`, else brand-when-active).

4. **Subagent-result card** (`ThreadView.tsx:392-398`): the parent-side card that
   renders a delivered child result currently uses `border-brand/40 bg-brand/5` +
   `text-brand`. Migrate it to the agent token (`border-agent/40 bg-agent/5`,
   `text-agent`) so the whole subagent surface reads as one color system. Small,
   on-theme, and makes the identity coherent.

A tiny shared class helper (e.g. `agentIconClass(role, active)` /
`agentBorderClass(role, active)`) or an inline role check keeps the three call
sites consistent without a new component.

## Files

- `apps/desktop/src/index.css` - `--agent` (dark + light) + `--color-agent` map.
- `apps/desktop/src/state/delivery.ts` - `isSubagentThread` pure helper.
- `apps/desktop/src/state/delivery.test.ts` - unit tests for `isSubagentThread`
  (and a `hasSubagents`/`childThreadIdsOf` presence check).
- `apps/desktop/src/state/store.ts` - `spawnChildThread` calls `openThread`.
- `apps/desktop/src/components/Sidebar.tsx` - agent-role Sparkle tint (child rows
  + parent-with-children rows).
- `apps/desktop/src/App.tsx` - agent-hue panel top edge for agent-role panels.
- `apps/desktop/src/components/ThreadView.tsx` - header Sparkle tint + migrate the
  subagent-result card to the agent token.
- `apps/desktop/DESIGN.md` - record the reserved agent hue in the color strategy.

## Testing

- Unit: `isSubagentThread` truth table; `childThreadIdsOf` parent detection (the
  `hasSubagents` predicate). bun test, no Tauri imports.
- Live-verify (this is a visual change): `bun run tauri:dev`, drive via the tauri
  MCP bridge, run a real DeepSeek agent that spawns a child, screenshot (a) the
  child auto-opening as a live panel, (b) the teal identity on the child row, the
  parent row, and both panel edges, (c) the migrated subagent-result card.

## Out of scope (tracked elsewhere)

FleetView consolidated multi-agent panel + per-type coloring (HOY-235, Wave 3);
steering the child (HOY-233, Phase 2); live-vs-done per-child state in the parent
marker (FleetView). No auto-open preference toggle (YAGNI).
