# Recursive subagents + concurrency limiter (HOY-245) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the structural depth-1 subagent cap to a numeric max depth (3) and add a concurrency limiter (cap + FIFO queue + foreground/resume bypass), so agents can spawn subagents N levels deep safely.

**Architecture:** Depth is threaded as a number from the renderer through the Rust core to the sidecar, which structurally decides whether a child gets the `agent` tool. A renderer-side limiter gates the start of subagent runs. A per-parent outstanding-children counter defers an intermediate agent's up-delivery until its descendants finish, fixing a premature-delivery bug that only appears at depth >= 2.

**Tech Stack:** Tauri v2 (Rust), React + TypeScript + Zustand, Bun; Pi coding agent as a spawned sidecar over JSONL-over-stdio RPC.

Design doc: `docs/plans/HOY-245-recursive-subagents-design.md`. Read it for the full rationale.

## Global Constraints

- No emojis and no em-dashes (`--`) anywhere: code, comments, docs, commit messages. An ASCII double-hyphen inside a string literal (e.g. the existing `[Subagent result -- type]` label) is allowed and must be preserved; it is not an em-dash.
- Plain commit messages, prefixed `HOY-245:`. No Co-Authored-By trailers.
- No new runtime dependencies. No Vercel AI SDK, no `ai`/`@ai-sdk/*`.
- `MAX_SUBAGENT_DEPTH = 3` and `MAX_CONCURRENT_AGENTS = 4` are named constants, colocated in `apps/desktop/src/state/limits.ts`; the sidecar keeps its own `MAX_SUBAGENT_DEPTH` constant with a comment cross-referencing the renderer one. Do not scatter magic numbers.
- Depth semantics: root user thread = depth 0; a thread at depth `d` may spawn iff `d < MAX_SUBAGENT_DEPTH`. So the first subagent is depth 1, and depth 3 is the deepest agent (it cannot spawn).
- The sidecar binary is stale until rebuilt: `packages/sidecar/build.sh` must run before any live verification of Task 3 or the whole branch.
- Keep the `AgentEvent` union and Rust/TS command signatures in sync when either changes (`events.rs` <-> `types.ts`, `commands.rs` <-> `lib/ipc.ts`).
- Transient run state (`runningAgents`, `agentQueue`, `outstandingChildren`) is NOT persisted, matching `completedAt`.

---

### Task 1: Renderer constants + pure tree helpers

Pure functions and constants, no behavior change. Everything here is unit-testable without Tauri.

**Files:**
- Create: `apps/desktop/src/state/limits.ts`
- Modify: `apps/desktop/src/state/delivery.ts` (add `threadDepth`, `descendantThreadIdsOf`; fix `childThreadIdsOf` doc comment)
- Test: `apps/desktop/src/state/delivery.test.ts` (extend)

**Interfaces:**
- Produces: `MAX_SUBAGENT_DEPTH`, `MAX_CONCURRENT_AGENTS` (from `limits.ts`); `threadDepth(projects, threadId): number`; `descendantThreadIdsOf(projects, ancestorId): string[]`. `childThreadIdsOf` keeps its existing single-level signature.

- [ ] **Step 1: Create the constants module**

`apps/desktop/src/state/limits.ts`:
```typescript
// Safety rails for recursive subagents (HOY-245). Named constants, not
// settings-UI knobs: a user-tunable depth would defeat the fork-bomb guard.
// The sidecar keeps its own MAX_SUBAGENT_DEPTH (packages/sidecar/pi-src/
// hoy-sidecar.ts) as the authoritative structural gate; keep the two in sync.

// A thread at depth d may spawn a child iff d < MAX_SUBAGENT_DEPTH. Root user
// thread is depth 0, so the deepest agent is depth 3 and cannot spawn.
export const MAX_SUBAGENT_DEPTH = 3;

// At most this many subagent initial runs stream at once; the rest queue.
// Foreground (user) turns and resume-on-delivery runs are exempt.
export const MAX_CONCURRENT_AGENTS = 4;
```

- [ ] **Step 2: Write failing tests for `threadDepth` and `descendantThreadIdsOf`**

Add to `delivery.test.ts` (match the existing `test(...)` style and the existing project/thread fixtures in that file). Build a depth-2 fixture: root `r` (no parent), child `c` (parent `r`), grandchild `g` (parent `c`), plus an unrelated root `u`.
```typescript
import { threadDepth, descendantThreadIdsOf } from "./delivery";

test("threadDepth counts ancestors, root is 0", () => {
  expect(threadDepth(projects, "r")).toBe(0);
  expect(threadDepth(projects, "c")).toBe(1);
  expect(threadDepth(projects, "g")).toBe(2);
});

test("threadDepth returns 0 for an unknown id", () => {
  expect(threadDepth(projects, "nope")).toBe(0);
});

test("descendantThreadIdsOf walks the whole subtree", () => {
  expect(descendantThreadIdsOf(projects, "r").sort()).toEqual(["c", "g"]);
  expect(descendantThreadIdsOf(projects, "c")).toEqual(["g"]);
  expect(descendantThreadIdsOf(projects, "g")).toEqual([]);
});

test("descendantThreadIdsOf is cycle-guarded", () => {
  // A corrupt fixture where a node points back up must not loop forever.
  const cyclic = /* build projects where c.parentThreadId = g and g.parentThreadId = c */;
  expect(() => descendantThreadIdsOf(cyclic, "c")).not.toThrow();
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd apps/desktop && bun test ./src/state/delivery.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 4: Implement the helpers in `delivery.ts`**

Fix the `childThreadIdsOf` doc comment (remove the "depth is capped at 1, so no grandchildren exist" clause; keep it single-level and say so). Add:
```typescript
// Depth of a thread in the subagent tree: 0 for a root (user) thread, +1 per
// ancestor. Walks parentThreadId up. Visited-guarded against corrupt data
// (the parent link is a tree by construction, so cycles never arise normally).
export function threadDepth(projects: Project[], threadId: string): number {
  const byId = new Map(projects.flatMap((p) => p.threads).map((t) => [t.id, t]));
  const seen = new Set<string>();
  let depth = 0;
  let cur = byId.get(threadId);
  while (cur?.parentThreadId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentThreadId);
    depth += 1;
  }
  return depth;
}

// Every transitive descendant of ancestorId (children, grandchildren, ...).
// For aggregate rollups; the archive/delete cascade uses childThreadIdsOf
// (single-level) because it self-recurses. Visited-guarded.
export function descendantThreadIdsOf(projects: Project[], ancestorId: string): string[] {
  const all = projects.flatMap((p) => p.threads);
  const out: string[] = [];
  const seen = new Set<string>([ancestorId]);
  const stack = [ancestorId];
  while (stack.length) {
    const parentId = stack.pop()!;
    for (const t of all) {
      if (t.parentThreadId === parentId && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd apps/desktop && bun test ./src/state/delivery.test.ts` (all pass) and `bun run check:ts` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/state/limits.ts apps/desktop/src/state/delivery.ts apps/desktop/src/state/delivery.test.ts
git commit -m "HOY-245: depth + descendant tree helpers and safety constants"
```

---

### Task 2: Rust depth plumbing

Thread a numeric `depth` through the session-spawn path so the sidecar receives it as an env var. Rust-only; no renderer or sidecar change here.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (the `create_session` command, ~`:290-308`)
- Modify: `apps/desktop/src-tauri/src/sidecar.rs` (`spawn_session_in` ~`:834-869`; `PiProcess::spawn` env ~`:90-130`; respawn path ~`:944-978`; the `subagent_types` mirror map ~`:754`, `:862-867`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `create_session` accepts a `depth: u32` argument (Tauri command param, camelCase `depth` on the wire); the spawned sidecar process gets `HOY_SUBAGENT_DEPTH=<depth>` in its env, preserved across respawn.

- [ ] **Step 1: Add `depth` to `spawn_session_in` and the process env**

In `sidecar.rs`, add a `depth: u32` parameter to `spawn_session_in` and pass it into `PiProcess::spawn`. In `PiProcess::spawn`, alongside the existing `if let Some(t) = subagent_type { command.env("HOY_SUBAGENT_TYPE", t); }` (`sidecar.rs:122-124`), add:
```rust
command.env("HOY_SUBAGENT_DEPTH", depth.to_string());
```
Always set it (root sessions pass depth 0). Store the depth in the session record beside `subagent_type` so respawn can restore it: add a `depths: Mutex<HashMap<SessionId, u32>>` map on `SidecarManager` mirroring the `subagent_types` map at `sidecar.rs:754`, populate it in `spawn_session_in`, and read it in the respawn path (`sidecar.rs:944-978`) to re-pass `HOY_SUBAGENT_DEPTH` on respawn.

- [ ] **Step 2: Add `depth` to the `create_session` command**

In `commands.rs`, add `depth: u32` to the `create_session` command signature (`:290-308`) and forward it to `manager.spawn_session_in(...)`. Keep argument order consistent with the existing `subagent_type` / `permission_mode` params.

- [ ] **Step 3: Build and run existing Rust tests**

Run: `cd apps/desktop/src-tauri && cargo build` (compiles) and `cargo test` (existing tests, incl. the JSONL framing and `events.rs` wire-shape tests, still pass).
Expected: PASS. No new Rust test is required for env passing; Task 3 + live-verify prove the sidecar reads it.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/sidecar.rs
git commit -m "HOY-245: relay subagent depth to the sidecar via HOY_SUBAGENT_DEPTH"
```

---

### Task 3: Sidecar depth gate (lift the structural cap)

Give a child the `agent` tool iff its depth is below the cap. This is the authoritative structural enforcement. Requires a sidecar rebuild before live-verify.

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-sidecar.ts`

**Interfaces:**
- Consumes: `HOY_SUBAGENT_DEPTH` env (Task 2).
- Produces: a child at depth `< MAX_SUBAGENT_DEPTH` can spawn (has `createHoyAgents`, `"agent"` in tools, and spawn guidance in its prompt); at or above the cap it cannot.

- [ ] **Step 1: Read depth and define the cap**

Near `hoy-sidecar.ts:47` (where `subagentType` is read), add:
```typescript
// Numeric depth from Rust (0 for root/user threads). A thread may spawn iff
// depth < MAX_SUBAGENT_DEPTH. Mirrors apps/desktop/src/state/limits.ts; keep
// the two in sync. This is the authoritative structural gate: a child at or
// beyond the cap never receives the agent tool, so it cannot spawn.
const subagentDepth = Number(process.env.HOY_SUBAGENT_DEPTH ?? 0);
const MAX_SUBAGENT_DEPTH = 3;
const canSpawn = subagentDepth < MAX_SUBAGENT_DEPTH;
```

- [ ] **Step 2: Gate the agent tool, its allowlist entry, and its prompt guidance on `canSpawn`**

The current code branches everything on `childType` (root vs child). Change the three spawn-related decisions to branch on `canSpawn` instead, while keeping `childType` for the non-spawn child specialization (its base tools + child prompt body):

- `extensionFactories` (`:122-124`): include `createHoyAgents(registry)` iff `canSpawn` (independent of `childType`):
  ```typescript
  extensionFactories: [
    createHoyPermissions(initialMode),
    createHoyMcp(mcpConfig),
    ...(canSpawn ? [createHoyAgents(registry)] : []),
  ],
  ```
- The `tools` allowlist (`:102`): a spawning-capable child needs `"agent"` present, mirroring how root's `HOY_TOOLS` includes it:
  ```typescript
  const baseTools = childType ? childType.tools : HOY_TOOLS;
  const tools = canSpawn && !baseTools.includes("agent")
    ? [...baseTools, "agent"]
    : baseTools;
  ```
- The system prompt (`:110-113`): a spawning-capable child must be told it can spawn and see the enabled types, mirroring root. The current call uses `buildHoySystemPrompt(hasMcp, !childType, advertised)` for the base and `effectiveChildPrompt(childType, buildHoySystemPrompt(hasMcp, false))` for a child. Change the "include agent guidance" flag from `!childType` to `canSpawn` for the root/base path, and for a spawning-capable child, build its prompt so the agent guidance + `advertised` types are included. Read `buildHoySystemPrompt` and `effectiveChildPrompt` signatures and wire the flags so: root -> guidance on; child with `canSpawn` -> child body + guidance on + advertised; child without `canSpawn` -> child body, guidance off (today's behavior).

Keep the unknown-type fail-closed throw (`:95-99`) unchanged. Keep the Gate-C `"agent"` strip in `hoy-agents-registry.ts` as defense in depth (the extension is the switch; a registry `.md` still cannot self-declare `agent`).

**Verification note:** confirm empirically in live-verify whether the `tools` allowlist is actually required for the agent tool to appear, or whether `createHoyAgents` alone suffices (root includes both, so both are set here to match). If a depth-2 child does not actually spawn, this wiring is where to look.

- [ ] **Step 3: Rebuild the sidecar and typecheck**

Run: `bash packages/sidecar/build.sh` (rebuilds the compiled binary; must succeed and assert the branded config dir). Also run the sidecar package's typecheck if one exists.
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/sidecar/pi-src/hoy-sidecar.ts
git commit -m "HOY-245: lift the sidecar depth cap, gate the agent tool on depth"
```

---

### Task 4: Renderer wiring: compute depth, pass it, refuse beyond the cap

Wire the Task 1 helpers and Task 2 Rust param into `createSession` and `spawnChildThread`.

**Files:**
- Modify: the `createSession` typed wrapper (search `apps/desktop/src/lib/ipc.ts` for `createSession`; it wraps `invoke("create_session", ...)`)
- Modify: `apps/desktop/src/state/store.ts` (`spawnChildThread`, `:798-871`)

**Interfaces:**
- Consumes: `threadDepth`, `MAX_SUBAGENT_DEPTH` (Task 1); `create_session`'s new `depth` param (Task 2).
- Produces: children are created with the correct depth; a spawn beyond the cap is refused.

- [ ] **Step 1: Add `depth` to the `createSession` wrapper**

In `lib/ipc.ts`, add a `depth: number` argument to `createSession` and include it in the `invoke("create_session", { ... })` args object (camelCase key `depth`). Place it consistently with the existing `subagentType` / `permissionMode` args. Update any other `createSession` call sites (e.g. the user-thread spawn in `submitPrompt`) to pass `depth: 0` for root threads.

- [ ] **Step 2: Compute and pass childDepth in `spawnChildThread`, refuse beyond the cap**

In `spawnChildThread` (`store.ts:798`), after resolving `found`/`parent` and before creating the child, compute:
```typescript
const childDepth = threadDepth(get().projects, parentThreadId) + 1;
if (childDepth > MAX_SUBAGENT_DEPTH) {
  // Belt-and-suspenders: a parent at max depth should not have had the agent
  // tool at all (the sidecar withholds it), so this should be unreachable.
  // Guard against a stale sidecar rather than spawning past the cap.
  console.warn(`HOY-245: refusing spawn at depth ${childDepth} > ${MAX_SUBAGENT_DEPTH}`);
  return;
}
```
Pass `childDepth` into the `createSession(cwd, null, payload.subagentType, parent.permissionMode ?? null, childDepth)` call (`:848-853`). Import `threadDepth` and `MAX_SUBAGENT_DEPTH`.

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/desktop && bun run check:ts` (exit 0) and `bun run build` (succeeds).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/ipc.ts apps/desktop/src/state/store.ts
git commit -m "HOY-245: compute and pass child depth, refuse spawns beyond the cap"
```

---

### Task 5: Concurrency limiter (cap + FIFO queue + foreground/resume bypass)

Gate the start of subagent initial runs on a free slot; queue the overflow; release on first done; purge on teardown.

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (add state + actions; restructure `spawnChildThread`; hook the done handler at `:1555-1588`; hook the teardown cascade at `:1424`, `:1454`)
- Test: `apps/desktop/src/state/store.test.ts` if one exists, else cover the pumpable pieces where a Tauri-free seam allows and prove the rest in live-verify.

**Interfaces:**
- Consumes: `MAX_CONCURRENT_AGENTS` (Task 1); `spawnChildThread` (Task 4).
- Produces: `runningAgents: Set<string>`, `agentQueue: string[]` store state; `pumpAgentQueue()` action; a `startChildRun` helper. A queued child is visible but not streaming.

- [ ] **Step 1: Add transient limiter state**

Add to the store's initial state: `runningAgents: new Set<string>()` and `agentQueue: [] as string[]`. Do NOT include them in any persistence/partialize allowlist (they are transient like `completedAt`). Add their types to the store's TS interface.

- [ ] **Step 2: Extract `startChildRun` and gate `spawnChildThread` on a slot**

Split `spawnChildThread` so the run body (the `try { createSession -> applyThreadModel -> applyThreadPermissionMode -> streamPromptOnThread } catch` block, `:846-870`) moves into a helper `startChildRun(childId: string, payload, childDepth: number)`. In `spawnChildThread`:
- Create + insert the child Thread as today (`parentThreadId`, `spawnedBy`, model/thinking), BUT do not seed a streaming assistant turn or set `streaming[childId]` yet, and do not call `openThread` here unconditionally (auto-open stays; HOY-246 will gate it later; leave the existing `get().openThread(childId)` call in place for now so behavior is unchanged from HOY-236).
- Then gate:
  ```typescript
  if (get().runningAgents.size < MAX_CONCURRENT_AGENTS) {
    set((s) => ({ runningAgents: new Set(s.runningAgents).add(childId) }));
    // seed the streaming assistant turn + streaming[childId] = true (the block
    // currently at :832-840), then:
    await startChildRun(childId, payload, childDepth);
  } else {
    set((s) => ({ agentQueue: [...s.agentQueue, childId] }));
    // queued: leave streaming false; the transcript shows the seeded user turn
    // only. FleetView (HOY-235) renders "queued" from agentQueue membership.
  }
  ```
  Note: `startChildRun` needs `childDepth` for the `createSession` call, and needs to re-seed the streaming turn when started from the pump (a queued child had no streaming turn). Seed the streaming assistant turn + `streaming[childId]=true` at the top of `startChildRun`, and have the immediate-start path rely on `startChildRun` to seed rather than seeding inline, so both paths are identical.

- [ ] **Step 3: Add `pumpAgentQueue` and release the slot on first done**

Add the action:
```typescript
pumpAgentQueue: () => {
  const s = get();
  if (!s.agentQueue.length || s.runningAgents.size >= MAX_CONCURRENT_AGENTS) return;
  const [next, ...rest] = s.agentQueue;
  set({ agentQueue: rest, runningAgents: new Set(s.runningAgents).add(next) });
  // Re-derive the child's payload + depth from state and start it.
  // Store the spawn payload on the child (or in a transient map keyed by
  // childId) at enqueue time so the pump can replay it; a small
  // `queuedPayloads: Record<string, {payload, childDepth}>` transient map is
  // the simplest carrier. Clear the entry when started.
  void startChildRun(next, /* payload */, /* childDepth */);
  // pump again in case more slots are free and the cap allows
  get().pumpAgentQueue();
},
```
Implementation detail: add a transient `queuedPayloads: Record<string, { payload: SpawnPayload; childDepth: number }>` map; write it in `spawnChildThread`'s queue branch, read+delete it in `pumpAgentQueue`. Keep it out of persistence.

In the done handler (`store.ts:1555`, the `event.kind === "done"` branch), before `void deliverAndDrain(threadId)` at `:1588`, release the initial-run slot (membership distinguishes an initial run from a resume run):
```typescript
if (useSessionStore.getState().runningAgents.has(threadId)) {
  useSessionStore.setState((s) => {
    const next = new Set(s.runningAgents);
    next.delete(threadId);
    return { runningAgents: next };
  });
  useSessionStore.getState().pumpAgentQueue();
}
```

- [ ] **Step 4: Purge the queue on teardown**

In `archiveThread` (`:1420-1441`) and `deleteThread` (`:1451-1471`), when tearing a thread down, also remove it from `agentQueue`, `runningAgents`, and `queuedPayloads` so a torn-down subtree never starts or leaks a slot. The cascade already recurses over `childThreadIdsOf`, so each descendant is visited; add the purge at the same point the thread is removed. After purging, call `pumpAgentQueue()` once (a freed slot may let a still-live queued agent start).

- [ ] **Step 5: Verify build + any store tests**

Run: `cd apps/desktop && bun run check:ts` (exit 0), `bun run build` (succeeds), and `bun test` (existing suites; the known HOY-241 `saveMcpServer` failures are pre-existing and unrelated). If a store test seam exists, add a test: seed `MAX_CONCURRENT_AGENTS + 2` spawns against one parent, assert exactly `MAX_CONCURRENT_AGENTS` enter `runningAgents` and 2 sit in `agentQueue`; simulate a done and assert one dequeues.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/state/store.ts apps/desktop/src/state/store.test.ts
git commit -m "HOY-245: concurrency limiter for subagent spawns (cap + FIFO queue)"
```

---

### Task 6: Delivery ordering across depths (defer up-delivery until children finish)

Fix the premature-delivery bug: an intermediate agent must not deliver its result up until its own children have delivered into it.

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (`deliverAndDrain` `:1702-1732`; `deliverToParent` `:1744-1813`; `spawnChildThread` increment site)
- Test: `apps/desktop/src/state/delivery.test.ts` or the store test seam

**Interfaces:**
- Consumes: the limiter and depth changes (Tasks 4-5); `isSubagentThread` (`delivery.ts`).
- Produces: `outstandingChildren: Record<string, number>` transient store state; `deliverAndDrain` defers when a thread has outstanding children.

- [ ] **Step 1: Add the outstanding-children counter and increment on spawn**

Add transient store state `outstandingChildren: {} as Record<string, number>` (not persisted). In `spawnChildThread`, when the child is created (regardless of run-now vs queued), increment the parent's count:
```typescript
set((s) => ({
  outstandingChildren: {
    ...s.outstandingChildren,
    [parentThreadId]: (s.outstandingChildren[parentThreadId] ?? 0) + 1,
  },
}));
```

- [ ] **Step 2: Decrement when a child's result is applied to the parent**

In `deliverToParent` (`:1744`), on the APPLY path only (past the busy-check at `:1745`, when it proceeds to seed + stream), decrement `outstandingChildren[parentThreadId]`. Fold it into the seed `setState` at `:1765-1785`:
```typescript
outstandingChildren: (() => {
  const cur = s.outstandingChildren[parentThreadId] ?? 0;
  const nextCount = Math.max(0, cur - 1);
  const copy = { ...s.outstandingChildren };
  if (nextCount === 0) delete copy[parentThreadId];
  else copy[parentThreadId] = nextCount;
  return copy;
})(),
```
Do NOT decrement on the busy/queued early-return path (`:1746-1747`); the later drain reaches the apply path and decrements then. Every `deliverToParent` apply corresponds to exactly one child result (steers use a different path), so one decrement per apply is correct.

- [ ] **Step 3: Defer up-delivery in `deliverAndDrain` when children are outstanding**

Restructure `deliverAndDrain` (`:1702-1732`):
```typescript
async function deliverAndDrain(finishedThreadId: string): Promise<void> {
  const state = useSessionStore.getState();
  const found = findThread(state.projects, finishedThreadId);
  if (!found) return;
  const { thread } = found;
  const outstanding = state.outstandingChildren[finishedThreadId] ?? 0;
  const deferUp = isSubagentThread(thread) && outstanding > 0;
  if (!deferUp && shouldDeliverToParent(thread)) {
    const childTurns = state.turns[finishedThreadId] ?? [];
    const delivery = buildDelivery(
      thread.spawnedBy?.type ?? "subagent",
      thread.spawnedBy?.agentId ?? "",
      childTurns,
    );
    await deliverToParent(thread.parentThreadId!, delivery);
    useSessionStore.setState((s) => ({
      projects: patchThread(s.projects, finishedThreadId, (th) => ({
        ...th,
        completedAt: th.completedAt ?? Date.now(),
      })),
    }));
    useSessionStore.getState().closePanel(finishedThreadId);
  }
  // Always drain deliveries queued INTO this thread from its own children, even
  // when deferring up: draining is what applies a child's result (and
  // decrements the counter), which is what eventually clears the defer.
  const next = takeNextDelivery(finishedThreadId);
  if (next) await deliverToParent(finishedThreadId, next);
}
```
When deferring, `completedAt` is intentionally NOT stamped and the panel is NOT closed: the agent is still logically running until its children report. The next grandchild delivery resumes it; on its resumed `done`, `outstandingChildren` is lower, and after the last child it reaches 0 and delivers up.

- [ ] **Step 4: Write ordering tests**

Cover, in `delivery.test.ts` (pure pieces) and/or the store seam:
- Leaf delivers immediately: `isSubagentThread` child with `outstandingChildren` undefined/0 -> `shouldDeliverToParent` true and no defer (depth-1 behavior unchanged).
- Depth-2 defer: an intermediate agent with `outstandingChildren = 1` does not deliver up; after the count reaches 0 it does.
- Deliver-once guard across depths: after an intermediate agent finally delivers up and `completedAt` is stamped, a further done does not re-deliver.
- Two grandchildren: counter reaches 0 only after both applied.

- [ ] **Step 5: Verify build + tests**

Run: `cd apps/desktop && bun run check:ts` (exit 0), `bun test ./src/state/delivery.test.ts` (pass), `bun run build` (succeeds).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/state/store.ts apps/desktop/src/state/delivery.test.ts
git commit -m "HOY-245: defer intermediate-agent delivery until descendants finish"
```

---

## Whole-branch verification (after all tasks)

1. Final whole-branch review (most capable model) over `git merge-base main HEAD..HEAD`.
2. Rebuild the sidecar: `bash packages/sidecar/build.sh`.
3. Live-verify with `bun run tauri:dev`, the tauri MCP bridge (port 9223), DeepSeek as the live model:
   - A root agent spawns a child that spawns a grandchild (depth cap lifted; the grandchild actually appears and runs).
   - A depth-3 great-grandchild spawn is refused (the depth-3 agent has no `agent` tool).
   - With overflow beyond `MAX_CONCURRENT_AGENTS` (temporarily lower the constant if needed to force it, then restore), queued spawns show queued and start as slots free.
   - Root's final result reflects the grandchild's contribution (ordering fix), not a result computed before the grandchild finished.
   - Archiving the root removes the whole subtree and leaves no queued/running leak.
4. Screenshot the depth-2 tree and the queued->running transition.
