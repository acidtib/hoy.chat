# Recursive subagents: lift the depth-1 cap + concurrency limiter (HOY-245) - design

Wave 3, safety-first. Enables agents to spawn subagents N levels deep, and makes
that safe with a concurrency limiter. Ships before or beside FleetView (HOY-235),
which renders arbitrary depth regardless. Touches the sidecar (Pi SDK entry), the
Rust core, and the renderer store, so the sidecar binary must be rebuilt before
live-verify.

## Problem

Subagent depth is hard-capped at 1: a child cannot spawn its own child. The cap
is **structural, not numeric** - there is no depth counter anywhere. A child
session is simply never handed the `agent` tool:

- `hoy-sidecar.ts:122-124`: `createHoyAgents(registry)` (the factory that
  registers the `agent` tool) is only in the root branch of
  `extensionFactories`; a child (identified by the `HOY_SUBAGENT_TYPE` env var)
  gets permissions + mcp but not agents.
- `hoy-sidecar.ts:95-99`: a child with an unknown type throws rather than falling
  through to the root branch (which would "promote it to a spawner").
- `hoy-agents-registry.ts:56-59`: `validateTools` strips `"agent"` from every
  registry tool list, so even a `.md` declaring `tools: [agent]` cannot get it.

The only signal a spawned agent has about its position is `HOY_SUBAGENT_TYPE`
(present = child, absent = root). There is no notion of depth, and no limit on
how many agents run at once: every `SubagentSpawned` event fires
`spawnChildThread` fire-and-forget (`store.ts:1512-1518`, `void`, not awaited),
each spawning its own OS process with no gate. N models each calling the `agent`
tool M times spawns N*M processes. That is the fork bomb this ticket must close
before deep trees are allowed.

Recursion also surfaces a latent **delivery-ordering bug** (see below) that
cannot occur at depth 1 and so has never been exercised.

## Design

Four coordinated changes. Two safety constants, colocated and cross-referenced:

- `MAX_SUBAGENT_DEPTH = 3` - a thread at depth `d` may spawn iff `d < 3`. Root
  user thread = depth 0; its child = depth 1; grandchild = 2; great-grandchild =
  3 (cannot spawn). Three levels of subagents below the user.
- `MAX_CONCURRENT_AGENTS = 4` - at most 4 subagent *initial* runs stream at once;
  the rest queue.

Both are named constants, not settings-UI knobs. A user-tunable depth defeats the
safety purpose; promoting either to a preference is a deferred follow-up.

### 1. Lift the depth cap (numeric depth, two independent enforcers)

Thread a numeric depth from the renderer down to the sidecar so the sidecar can
decide, structurally, whether a given child gets the `agent` tool.

**Renderer** computes the child's depth and refuses beyond the cap:
- New pure helper `threadDepth(projects, threadId)` in `delivery.ts`: walks
  `parentThreadId` to the root, returning the count of ancestors (root = 0).
  Visited-guarded against corrupt data (defensive; the parent link is a tree by
  construction, so cycles cannot arise normally).
- In `spawnChildThread` (`store.ts:798`): `childDepth = threadDepth(projects,
  parentThreadId) + 1`. If `childDepth > MAX_SUBAGENT_DEPTH`, do not spawn (log +
  surface a thread error on the parent, or drop silently with a console warning);
  this is a belt-and-suspenders guard for a stale sidecar, since a parent at max
  depth should not have had the `agent` tool at all.
- Pass `childDepth` to `createSession`.

**Rust** relays depth as an env var, mirroring how `HOY_SUBAGENT_TYPE` is passed:
- Add a `depth: u32` param to the `create_session` command (`commands.rs:290-308`)
  -> `spawn_session_in` (`sidecar.rs:834-869`) -> `PiProcess::spawn`
  (`sidecar.rs:90-130`), setting `.env("HOY_SUBAGENT_DEPTH", depth.to_string())`.
- Mirror it in the respawn path (`sidecar.rs:944-978`) with a `depths` map beside
  the existing `subagent_types` map (`sidecar.rs:754`, `:862-867`), so a
  respawned child keeps its depth.

**Sidecar** enforces its own cap (the authoritative structural gate):
- `hoy-sidecar.ts`: read `const depth = Number(process.env.HOY_SUBAGENT_DEPTH ??
  0)` near line 47. Define `const MAX_SUBAGENT_DEPTH = 3` (comment cross-refs the
  renderer constant).
- Include `createHoyAgents(registry)` in `extensionFactories` iff
  `depth < MAX_SUBAGENT_DEPTH` - regardless of root-vs-child. Root (depth 0) still
  gets it; children at depth 1 and 2 now get it; depth 3 does not. This replaces
  the current root-only branch.
- **Verification point for the implementer:** confirm whether the `agent` tool's
  availability is governed solely by `extensionFactories` (the extension registers
  the tool) or also by the `tools` allowlist (`HOY_TOOLS` vs `childType.tools`,
  `hoy-sidecar.ts:102`). If the allowlist also gates it, a spawning-capable child
  must have `"agent"` present in its effective tools. Keep the Gate-C strip
  (`hoy-agents-registry.ts:56-59`) as defense in depth; the extension is the
  switch. Test a real depth-2 spawn in live-verify to confirm.
- Keep the unknown-type fail-closed throw (`hoy-sidecar.ts:95-99`) unchanged.

Two enforcers by design: a buggy or stale renderer cannot force unbounded depth
because the sidecar refuses to hand out the tool past its own constant; and the
renderer refuses to create the session past its constant. Both = 3.

### 2. Concurrency limiter (renderer, foreground- and resume-exempt)

The limiter lives in the renderer because `spawnChildThread` is the single funnel
every spawn passes through at every depth (a grandchild's spawn notify arrives on
the grandchild's own channel and is routed to `spawnChildThread` keyed by the
emitting thread), and because the "foreground bypass" requirement needs to tell a
subagent spawn apart from a user prompt - which only the renderer knows. A
Rust-side semaphore on `spawn_session_in` would also throttle user threads
opening sessions, which we do not want.

State added to the store (all transient, not persisted - matching `completedAt`):
- `runningAgents: Set<string>` - subagent thread ids whose *initial* run is
  currently streaming.
- `agentQueue: string[]` - FIFO of child thread ids waiting for a slot.

**Slot = an in-flight initial spawn run.** A slot is taken when an initial run
starts and released on that run's first `done`. Resume runs (a delivered child
result resuming its parent) and foreground (root) turns never consult the queue
and never occupy a slot - they finish existing work rather than creating new
fan-out, and are self-bounded by tree size. This makes the limiter deadlock-free:
a slot holder is always actively streaming and will release, so there is no
hold-and-wait.

Restructure `spawnChildThread`:
- Create + insert the child Thread (visible in sidebar/FleetView immediately),
  set `parentThreadId`/`spawnedBy` as today, but do NOT seed a streaming assistant
  block yet and do NOT set `streaming[childId]` (a queued child is not streaming).
- Extract the run body (`createSession` -> `applyThreadModel` ->
  `applyThreadPermissionMode` -> `streamPromptOnThread`) into a new
  `startChildRun(childId, payload, childDepth)` helper.
- Gate: if `runningAgents.size < MAX_CONCURRENT_AGENTS`, add `childId` to
  `runningAgents`, seed the streaming assistant block + `streaming[childId]=true`,
  and call `startChildRun`. Else push `childId` onto `agentQueue` (status:
  queued).
- A `pumpAgentQueue()` action: while `agentQueue` non-empty and
  `runningAgents.size < MAX_CONCURRENT_AGENTS`, shift the next id and start its
  run (re-reading the child + its payload/depth from state).
- On a subagent's first `done` (initial run end - see the delivery section for
  where this hooks in), remove it from `runningAgents` and call
  `pumpAgentQueue()`.
- **Teardown purge:** when archive/delete cascades over descendants
  (`store.ts:1424`, `:1454`), also remove those ids from `agentQueue` and
  `runningAgents` so a torn-down subtree never starts or leaks a slot.

Status derivation (consumed by FleetView, HOY-235; this ticket only produces the
state): queued = id in `agentQueue`; running = `streaming[id]`; error =
`threadErrors[id]`; done = `completedAt` set; waiting-on-children = intermediate
agent, first done fired, not streaming, not completed, not queued.

### 3. Delivery ordering across depths (the subtle correctness fix)

At depth 1 an agent is always a leaf, so it delivers its result up the moment its
turn ends. At depth >= 2 an intermediate agent C is both a spawner (of grandchild
G) and a deliverer (up to root). With async delivery (HOY-233) C's turn ends
before G finishes, and today `deliverAndDrain(C)` (`store.ts:1702-1732`) delivers
C's result to root immediately and stamps `C.completedAt` (`:1716`). When G later
delivers into C and resumes C, C's second `done` is gated out by
`shouldDeliverToParent` (`delivery.ts:63-68`, `!completedAt` now false), so G's
contribution reaches C but never propagates to root. **Root gets C's result
computed before G's work - a real bug this ticket introduces by enabling depth 2.**

Fix: an intermediate agent defers delivering up until it has no outstanding
children. Track it explicitly with a counter, decremented when a child's result
is actually applied to the parent (not merely queued), because `completedAt` is
stamped even for a delivery that is only queued (`deliverAndDrain` stamps after
`deliverToParent` returns, `store.ts:1716`, even on the busy/queued path) - so
`completedAt` alone cannot mean "processed by the parent."

Store state (transient): `outstandingChildren: Record<string, number>` keyed by
parent thread id.
- Increment `outstandingChildren[parentThreadId]` in `spawnChildThread` when the
  child is created.
- Decrement it at the single point where a child's delivery is *applied* to the
  parent: inside `deliverToParent` (`store.ts:1744-1813`) on the path past the
  busy-check, immediately before `streamPromptOnThread(parent, ...)`. Not on the
  queued path; the later drain (`takeNextDelivery` / `deliverAndDrain`'s own-queue
  drain at `store.ts:1730`) reaches the apply path and decrements then.

Restructure `deliverAndDrain(finishedThreadId)`:
1. Compute `deferUp = isSubagentThread(thread) && (outstandingChildren[thread.id]
   ?? 0) > 0`.
2. If not deferring and `shouldDeliverToParent(thread)`: build delivery, call
   `deliverToParent`, stamp `completedAt`, close the child panel (as today).
3. If deferring: skip the up-delivery, do NOT stamp `completedAt`, do NOT close
   the panel - the agent waits.
4. **Always** drain this thread's own queued deliveries (deliveries INTO it from
   its children) - `store.ts:1730` - regardless of the defer, since draining is
   what applies a child's result and decrements the counter.
5. **Always** release the concurrency slot for this thread's *initial* run
   (remove from `runningAgents`, `pumpAgentQueue`) - independent of defer, so a
   deferring agent does not hold a slot while waiting for its children (this is
   what keeps deep trees from deadlocking under a small cap).

Why this converges: C's initial done -> `outstandingChildren[C] = childCount > 0`
-> defer, drain C's inbound queue. Each grandchild delivery applied to C
decrements the counter and resumes C; deliveries into C are serialized by
`deliveringParents` (`store.ts:1738`), so C runs once per grandchild. On C's done
after the LAST grandchild applied, `outstandingChildren[C] == 0` -> no defer -> C
delivers its now-complete result up to root. A leaf (no children,
`outstandingChildren` undefined -> 0) delivers immediately, unchanged from today,
so depth-1 behavior is identical.

`shouldDeliverToParent` keeps its signature; the defer decision lives in
`deliverAndDrain` (it needs store state - the counter - that the pure helper
should not reach into). Add the counter decrement as a small internal action so
the two apply sites (direct and drained) share it.

### 4. Fix depth-1 assumptions in the tree helpers

- `childThreadIdsOf` (`delivery.ts:82-87`) stays **single-level**. Its callers -
  the archive/delete cascade (`store.ts:1424`, `:1454`) - are self-recursive
  (each `archiveThread(child)` re-queries that child's direct children), so they
  are already correct for arbitrary depth once the cap lifts; making
  `childThreadIdsOf` transitive would double-visit. Only its doc comment
  (`delivery.ts:79-81`, "depth is capped at 1, so no grandchildren exist") is
  wrong and must be corrected.
- Add `descendantThreadIdsOf(projects, ancestorId): string[]` - a transitive,
  visited-guarded walk of all descendants, for aggregate rollups and any
  "all descendants" need. FleetView (HOY-235) builds the actual token/cost
  rollup selector on top of this; this ticket ships only the helper + tests.
- Confirm the cascade is grandchild-safe with a depth-2 archive test.

## Files

- `packages/sidecar/pi-src/hoy-sidecar.ts` - read `HOY_SUBAGENT_DEPTH`, define
  `MAX_SUBAGENT_DEPTH`, gate `createHoyAgents` on depth.
- `apps/desktop/src-tauri/src/commands.rs` - `depth` param on `create_session`.
- `apps/desktop/src-tauri/src/sidecar.rs` - relay `HOY_SUBAGENT_DEPTH` env in
  spawn + respawn; `depths` mirror map.
- `apps/desktop/src/lib/ipc.ts` (or wherever `createSession` is wrapped) - add
  `depth` arg.
- `apps/desktop/src/state/delivery.ts` - `threadDepth`, `descendantThreadIdsOf`,
  corrected `childThreadIdsOf` doc; the outstanding-children counter helper if
  colocated here.
- `apps/desktop/src/state/store.ts` - depth compute + pass; `runningAgents`,
  `agentQueue`, `outstandingChildren` state; `startChildRun`, `pumpAgentQueue`;
  restructured `spawnChildThread` and `deliverAndDrain`; teardown purge.
- `apps/desktop/src/state/limits.ts` (new) - `MAX_SUBAGENT_DEPTH`,
  `MAX_CONCURRENT_AGENTS` renderer constants.
- `apps/desktop/src/state/delivery.test.ts` - `threadDepth`,
  `descendantThreadIdsOf` unit tests.
- A store-level test for the limiter (queue/pump/slot release) and the
  delivery-ordering defer, if a testable seam exists without Tauri (mirror how
  existing store logic is tested; otherwise cover the pure pieces and prove the
  rest in live-verify).

## Testing

- Unit: `threadDepth` (root 0, child 1, grandchild 2; visited guard);
  `descendantThreadIdsOf` (depth-2 tree, no double-count, cycle guard);
  `childThreadIdsOf` still single-level. Deliver-once guard across depths.
- Unit/logic: limiter - N spawns over the cap queue; a `done` pumps exactly one;
  foreground and resume bypass; teardown purges the queue.
- Unit/logic: delivery ordering - a depth-2 chain delivers grandchild -> child ->
  root in order; child with two grandchildren defers until both applied; leaf
  delivers immediately (depth-1 unchanged).
- Live-verify (sidecar rebuilt): `bun run tauri:dev`, tauri MCP bridge, DeepSeek.
  Run a root agent that spawns a child that spawns a grandchild; confirm (a) the
  grandchild actually spawns (depth cap lifted), (b) a depth-3 great-grandchild is
  refused (no `agent` tool), (c) with a low cap, overflow spawns show queued then
  start as slots free, (d) root's final result reflects the grandchild's work
  (ordering fix), (e) archiving the root removes the whole subtree.

## Out of scope (tracked elsewhere)

- `max_turns` / per-spawn turn budget (HOY-244) - recommended companion cost
  lever, but the depth cap + concurrency cap already close the fork bomb; keep
  this ticket bounded.
- Settings-UI knobs for `MAX_SUBAGENT_DEPTH` / `MAX_CONCURRENT_AGENTS` - constants
  for now; promote later if needed.
- Recursive-spawn consent UX (a grandchild's `ctx.ui.select` consent prompt) -
  keep whatever the root path does; verify it surfaces or auto-approves under the
  inherited permission mode in live-verify; redesign as a follow-up only if broken.
- Aggregate token/cost rollup selector + UI - the `descendantThreadIdsOf` helper
  ships here; the rollup lands in FleetView (HOY-235).
