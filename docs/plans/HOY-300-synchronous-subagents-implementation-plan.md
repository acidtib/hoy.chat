# HOY-300: Synchronous Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `agent` tool block until its child finishes and return the child's result in-band (like Claude Code's Task tool), so a parent has every finding before it continues and a plan-mode `<proposed_plan>` is the terminal turn — replacing HOY-233's fire-and-forget async delivery.

**Architecture:** The `agent` tool issues a *blocking* `ctx.ui.input` request carrying a `@hoy/spawn-subagent-sync:` payload; Rust classifies it as a dialog (so it's abort-tracked) and emits a `SubagentSpawnSync` event carrying the request id; the renderer spawns the child as a watchable first-class thread and, on the child's `done`, answers the parent's blocked request with the child's result text via the existing `respond_permission`/`respond_ui` channel. The child's result becomes the tool result in the parent's transcript — no late turn injection, no auto-wake. Pi runs multiple tool calls concurrently, so parallel `agent` calls yield parallel synchronous subagents.

**Tech Stack:** Pi coding-agent SDK (`ctx.ui.input` blocking dialog, `extension_ui_request`/`extension_ui_response` frames), TypeScript sidecar extension (`packages/sidecar/pi-src`), Rust/Tauri (`apps/desktop/src-tauri`), Zustand renderer store + React (`apps/desktop/src`), bun test.

## Global Constraints

- No new Pi RPC frame — ride the existing `extension_ui_request` (`input`) / `extension_ui_response` round-trip only (frame set is fixed).
- The `agent` tool must stay non-`sequential` (no `executionMode`) so Pi keeps executing parallel tool calls concurrently (`agent-loop.js:254`).
- No Pi-side timeout is imposed and none must be introduced — the blocking request must wait indefinitely for the child (the `ctx.ui.input` call passes no `opts.timeout`).
- The child remains a first-class, watchable, steerable thread (`parentThreadId` + `spawnedBy` preserved); only the *result-delivery* mechanism changes.
- Depth cap `MAX_SUBAGENT_DEPTH = 3` and the first-use consent gate are unchanged.
- Sentinel prefix must be byte-identical in TS and Rust: `@hoy/spawn-subagent-sync:` (mirror the existing `SPAWN_NOTIFY_PREFIX` pattern).
- No co-author trailer on commits (repo rule). Commit after each task.
- Rebuild the sidecar (`packages/sidecar/build.sh`) before any live test — prompt/tool changes are compiled into the binary.

## File Structure

**Sidecar (TypeScript):**
- `packages/sidecar/pi-src/hoy-agents.ts` — the `agent` tool. `run()` changes from fire-and-forget notify to a blocking `ctx.ui.input`; export a new `SPAWN_SYNC_PREFIX`.
- `packages/sidecar/pi-src/hoy-agents.test.ts` — new/updated unit tests for the tool (create if absent).

**Rust:**
- `apps/desktop/src-tauri/src/events.rs` — add `SubagentSpawnSync` variant (kind `subagentSpawnSync`).
- `apps/desktop/src-tauri/src/sidecar.rs` — `classify_extension_ui` `input` branch detects the sync prefix → `Dialog(SubagentSpawnSync{...})`; add `SPAWN_SYNC_PREFIX` const.

**Renderer:**
- `apps/desktop/src/lib/types.ts` — extend the `PiEvent` union with `subagentSpawnSync`; remove the `subagentResult` turn `origin` (Task 6).
- `apps/desktop/src/lib/ipc.ts` — map the `subagentSpawnSync` event (event decoding).
- `apps/desktop/src/state/subagent-requests.ts` — **new** pure module: the child→pending-request map + result framing helper (unit-testable, no Tauri imports).
- `apps/desktop/src/state/store.ts` — new `subagentSpawnSync` event branch; `spawnChildThread` records the request mapping; child `done` responds to the parent instead of `deliverAndDrain`; remove the async-delivery calls.
- `apps/desktop/src/state/delivery.ts` — remove the delivery/queue helpers (`buildDelivery`, `queueDelivery`, `takeNextDelivery`, `pendingDeliveries`, `shouldDeliverToParent`, `shouldDeferUpDelivery`, `shouldDecrementParentOnTeardown`); keep the tree helpers (`isSubagentThread`, `childThreadIdsOf`, `threadDepth`, `descendantThreadIdsOf`, `extractResultText`).
- `apps/desktop/src/components/ThreadView.tsx` — remove the `subagentResult` user-turn rendering; keep `flagPlanReadyIfPresent` working (plan is terminal again).
- `apps/desktop/tests/subagent-requests.test.ts` — **new** tests for the pure module.
- `apps/desktop/src/state/delivery.test.ts` (or `tests/delivery.test.ts`) — trim removed-helper tests.

---

### Task 1: `agent` tool blocks and returns the child result in-band

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-agents.ts`
- Test: `packages/sidecar/pi-src/hoy-agents.test.ts` (create)

**Interfaces:**
- Consumes: `ExtensionContext.ui.input(title: string, opts?): Promise<string | undefined>` (Pi SDK; resolves to the answer `value`, or `undefined` when cancelled).
- Produces: `export const SPAWN_SYNC_PREFIX = "@hoy/spawn-subagent-sync:"`. The tool emits `ctx.ui.input(`${SPAWN_SYNC_PREFIX}${JSON.stringify({ agentId, subagentType, task })}`)` and returns `{ content: [{ type: "text", text: <result-or-note> }], details: { agentId } }`. The JSON payload shape `{ agentId: string, subagentType: string, task: string }` is what Rust (Task 2) parses.

- [ ] **Step 1: Write the failing test.** In a new `hoy-agents.test.ts`, exercise `run()` with a stub `ctx` whose `ui.input` resolves to `"CHILD RESULT"`, and assert the tool returns that text and passes a `SPAWN_SYNC_PREFIX`-prefixed title whose JSON carries `subagentType` and `task`.

```ts
import { describe, expect, test } from "bun:test";
import { createHoyAgents, SPAWN_SYNC_PREFIX } from "./hoy-agents";
import { BUILTIN_SUBAGENTS } from "./hoy-agents-registry";

function registry() {
  return Object.fromEntries(BUILTIN_SUBAGENTS.map((t) => [t.name, t]));
}

test("agent tool blocks on ui.input and returns the child result in-band", async () => {
  let seenTitle = "";
  const ctx: any = {
    isProjectTrusted: () => true,
    ui: {
      input: async (title: string) => {
        seenTitle = title;
        return "CHILD RESULT";
      },
      notify: () => {
        throw new Error("must not notify: spawning is synchronous now");
      },
    },
  };
  // Reach the private run() via the registered tool.
  let executed: any;
  const pi: any = { registerTool: (t: any) => (executed = t) };
  createHoyAgents(registry(), false)(pi);
  const out = await executed.execute("id", { subagentType: "Explore", task: "look at X" }, undefined, undefined, ctx);
  expect(seenTitle.startsWith(SPAWN_SYNC_PREFIX)).toBe(true);
  const payload = JSON.parse(seenTitle.slice(SPAWN_SYNC_PREFIX.length));
  expect(payload.subagentType).toBe("Explore");
  expect(payload.task).toBe("look at X");
  expect(out.content[0].text).toBe("CHILD RESULT");
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd packages/sidecar && bun test pi-src/hoy-agents.test.ts`. Expected: FAIL (`SPAWN_SYNC_PREFIX` not exported / `run` still notifies).

- [ ] **Step 3: Implement.** In `hoy-agents.ts`: add `export const SPAWN_SYNC_PREFIX = "@hoy/spawn-subagent-sync:";`. Replace the notify block (current lines ~52-62) with:

```ts
    const agentId = crypto.randomUUID();
    const payload = JSON.stringify({ agentId, subagentType: type.name, task });
    // Blocking round-trip (HOY-300): the renderer spawns the child, runs it to
    // completion, and answers this request with the child's result. No Pi-side
    // timeout, so a long child is safe. Cancelled (abort/deny) -> undefined.
    const result = await ctx.ui.input(`${SPAWN_SYNC_PREFIX}${payload}`);
    return {
      content: [
        {
          type: "text" as const,
          text:
            result && result.trim().length > 0
              ? result
              : `The ${type.name} subagent was stopped before returning a result.`,
        },
      ],
      details: { agentId },
    };
```

Also update the tool `description` (remove "Fire-and-forget…"): `"Spawn a specialized child agent to work on a task in its own thread. subagentType selects a registered agent type. Blocks until the child finishes and returns its result to you."`

- [ ] **Step 4: Run tests, verify pass.** Run: `cd packages/sidecar && bun test pi-src/hoy-agents.test.ts && bun test`. Expected: PASS (new test green; full sidecar suite green).

- [ ] **Step 5: Commit.**

```bash
git add packages/sidecar/pi-src/hoy-agents.ts packages/sidecar/pi-src/hoy-agents.test.ts
git commit -m "HOY-300: agent tool blocks on ui.input and returns the child result in-band"
```

---

### Task 2: Rust classifies the sync-spawn request → `SubagentSpawnSync` event

**Files:**
- Modify: `apps/desktop/src-tauri/src/events.rs`
- Modify: `apps/desktop/src-tauri/src/sidecar.rs`

**Interfaces:**
- Consumes: the `input`-method `extension_ui_request` whose `title` starts with `SPAWN_SYNC_PREFIX` and whose remainder is `{ agentId, subagentType, task }` JSON (Task 1).
- Produces: `AgentEvent::SubagentSpawnSync { request_id: String (serde "requestId"), agent_id (serde "agentId"), subagent_type (serde "subagentType"), task }`, serialized with `kind: "subagentSpawnSync"`. Because it is returned as `ExtUiOutcome::Dialog`, `route_message` (sidecar.rs:529) tracks `request_id` in `pending_ui`, so abort cancels the blocked tool.

- [ ] **Step 1: Write the failing test.** In `events.rs` tests (mirror the existing `SubagentSpawned` serde test near line 305), assert `SubagentSpawnSync` serializes with `kind:"subagentSpawnSync"` and camelCase `requestId`/`agentId`/`subagentType`.

```rust
#[test]
fn subagent_spawn_sync_serializes_camelcase() {
    let v = serde_json::to_value(AgentEvent::SubagentSpawnSync {
        request_id: "r1".into(),
        agent_id: "a1".into(),
        subagent_type: "Explore".into(),
        task: "look".into(),
    })
    .unwrap();
    assert_eq!(v["kind"], "subagentSpawnSync");
    assert_eq!(v["requestId"], "r1");
    assert_eq!(v["agentId"], "a1");
    assert_eq!(v["subagentType"], "Explore");
}
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml subagent_spawn_sync`. Expected: FAIL (variant absent).

- [ ] **Step 3: Implement.** In `events.rs`, add after the `SubagentSpawned` variant (line ~102):

```rust
    // HOY-300: a SYNCHRONOUS subagent spawn. Carries the request id of the
    // parent's blocked agent-tool `ctx.ui.input`; the renderer answers it with
    // the child's result via respond_permission -> respond_ui when the child is
    // done. A Dialog outcome, so route_message abort-tracks request_id.
    SubagentSpawnSync {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "subagentType")]
        subagent_type: String,
        task: String,
    },
```

In `sidecar.rs`, add near `SPAWN_NOTIFY_PREFIX` (line ~31): `const SPAWN_SYNC_PREFIX: &str = "@hoy/spawn-subagent-sync:";`. In `classify_extension_ui`, change the `"input" | "editor"` arm so `input` checks the prefix first:

```rust
        "input" => {
            let raw = str_field("title").unwrap_or_default();
            match raw
                .strip_prefix(SPAWN_SYNC_PREFIX)
                .and_then(|j| serde_json::from_str::<Value>(j).ok())
            {
                // HOY-300: synchronous subagent spawn — a Dialog so route_message
                // tracks request_id in pending_ui (abort cancels the blocked tool).
                Some(p) => ExtUiOutcome::Dialog(AgentEvent::SubagentSpawnSync {
                    request_id: id.to_string(),
                    agent_id: p.get("agentId").and_then(Value::as_str).unwrap_or_default().to_string(),
                    subagent_type: p.get("subagentType").and_then(Value::as_str).unwrap_or_default().to_string(),
                    task: p.get("task").and_then(Value::as_str).unwrap_or_default().to_string(),
                }),
                None => ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
                    request_id: id.to_string(),
                    method: "input".to_string(),
                    title: raw,
                    message: None,
                    options: None,
                    placeholder: str_field("placeholder"),
                    prefill: str_field("prefill"),
                    tool_call_id: None,
                    tool_name: None,
                    tool_args: None,
                }),
            }
        }
        "editor" => ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
            request_id: id.to_string(),
            method: "editor".to_string(),
            title: str_field("title").unwrap_or_default(),
            message: None,
            options: None,
            placeholder: str_field("placeholder"),
            prefill: str_field("prefill"),
            tool_call_id: None,
            tool_name: None,
            tool_args: None,
        }),
```

- [ ] **Step 4: Run tests, verify pass.** Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`. Expected: PASS (new + existing `classify_extension_ui`/events tests green). Add a `classify_extension_ui` unit test feeding an `input` request with a `SPAWN_SYNC_PREFIX` title and asserting a `SubagentSpawnSync` outcome.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/events.rs apps/desktop/src-tauri/src/sidecar.rs
git commit -m "HOY-300: Rust classifies the sync-spawn input request into SubagentSpawnSync"
```

---

### Task 3: Pure request-map module + renderer spawns child on `subagentSpawnSync`

**Files:**
- Create: `apps/desktop/src/state/subagent-requests.ts`
- Create: `apps/desktop/tests/subagent-requests.test.ts`
- Modify: `apps/desktop/src/lib/types.ts` (PiEvent union), `apps/desktop/src/lib/ipc.ts` (event decode), `apps/desktop/src/state/store.ts`

**Interfaces:**
- Consumes: the `subagentSpawnSync` event `{ kind: "subagentSpawnSync", requestId, agentId, subagentType, task }` (Task 2); `spawnChildThread(parentThreadId, payload)` (existing, store.ts:937); `extractResultText(turns)` (delivery.ts:12).
- Produces:
  - `apps/desktop/src/state/subagent-requests.ts`:
    - `type SubagentRequest = { parentThreadId: string; parentSessionId: string; requestId: string }`
    - `const subagentRequests = new Map<string /*childThreadId*/, SubagentRequest>()`
    - `function recordSubagentRequest(childThreadId: string, req: SubagentRequest): void`
    - `function takeSubagentRequest(childThreadId: string): SubagentRequest | undefined` (get + delete)
    - `function frameSubagentResult(subagentType: string, resultText: string): string` — the in-band tool result text.
  - `SpawnPayload` (store.ts:270) gains `requestId: string`.

- [ ] **Step 1: Write the failing test** (`tests/subagent-requests.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import {
  recordSubagentRequest,
  takeSubagentRequest,
  frameSubagentResult,
} from "@/state/subagent-requests";

test("record then take returns once, then undefined", () => {
  recordSubagentRequest("c1", { parentThreadId: "p1", parentSessionId: "s1", requestId: "r1" });
  expect(takeSubagentRequest("c1")?.requestId).toBe("r1");
  expect(takeSubagentRequest("c1")).toBeUndefined();
});

test("frameSubagentResult labels the result with the type", () => {
  const s = frameSubagentResult("Explore", "found it");
  expect(s).toContain("Explore");
  expect(s).toContain("found it");
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd apps/desktop && bun test tests/subagent-requests.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement the module.**

```ts
// HOY-300: pending synchronous-subagent requests. When the parent's agent tool
// blocks on ctx.ui.input, Rust surfaces a subagentSpawnSync event; the store
// records the child->request mapping here and, on the child's done, answers the
// parent's blocked request with the child's result. Pure (no Tauri imports).
export type SubagentRequest = {
  parentThreadId: string;
  parentSessionId: string;
  requestId: string;
};

const subagentRequests = new Map<string, SubagentRequest>();

export function recordSubagentRequest(childThreadId: string, req: SubagentRequest): void {
  subagentRequests.set(childThreadId, req);
}

export function takeSubagentRequest(childThreadId: string): SubagentRequest | undefined {
  const req = subagentRequests.get(childThreadId);
  if (req) subagentRequests.delete(childThreadId);
  return req;
}

// The literal double-hyphen is an ASCII separator, not an em-dash.
export function frameSubagentResult(subagentType: string, resultText: string): string {
  return `[${subagentType} subagent result]\n\n${resultText}`;
}
```

- [ ] **Step 4: Wire the event.** In `types.ts` add `subagentSpawnSync` to the `PiEvent` union (`{ kind: "subagentSpawnSync"; requestId: string; agentId: string; subagentType: string; task: string }`); in `ipc.ts` decode it alongside `subagentSpawned`. In `store.ts` `SpawnPayload` (line 270) add `requestId: string`. Add the event branch right after the existing `subagentSpawned` branch (store.ts:2136), resolving the parent's `sessionId` and recording the mapping before spawning:

```ts
    if (event.kind === "subagentSpawnSync") {
      const parentSessionId = findThread(useSessionStore.getState().projects, threadId)?.thread.sessionId;
      if (!parentSessionId) return; // parent must be live to have issued the request
      void useSessionStore.getState().spawnChildThread(threadId, {
        agentId: event.agentId,
        subagentType: event.subagentType,
        task: event.task,
        requestId: event.requestId,
      });
      return;
    }
```

In `spawnChildThread` (store.ts:937), after `childId` is minted and before the concurrency gate, record the mapping so the child's eventual `done` can find it:

```ts
    // HOY-300: remember which blocked parent request this child answers.
    recordSubagentRequest(childId, {
      parentThreadId,
      parentSessionId: parent.sessionId!,
      requestId: payload.requestId,
    });
```

- [ ] **Step 5: Run tests, verify pass.** Run: `cd apps/desktop && bun test tests/subagent-requests.test.ts && bun run check:ts`. Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/state/subagent-requests.ts apps/desktop/tests/subagent-requests.test.ts apps/desktop/src/lib/types.ts apps/desktop/src/lib/ipc.ts apps/desktop/src/state/store.ts
git commit -m "HOY-300: renderer records the pending request and spawns the child on subagentSpawnSync"
```

---

### Task 4: On the child's `done`, answer the parent's blocked request in-band

**Files:**
- Modify: `apps/desktop/src/state/store.ts`

**Interfaces:**
- Consumes: `takeSubagentRequest(childThreadId)` + `frameSubagentResult` (Task 3); `extractResultText(turns)` (delivery.ts:12); `respondPermission(sessionId, requestId, { value })` (ipc.ts:379).
- Produces: `respondSubagentResult(childThreadId: string): void` — extracts the child's result, answers the parent's blocked `ctx.ui.input`, and marks the child terminal. Replaces the `deliverAndDrain(childThreadId)` call in the `done` handler.

- [ ] **Step 1: Write the failing test.** Add a store-level test (mirror existing store tests) that: seeds a parent thread with `sessionId:"ps"`, records a request for child `c1`, seeds `c1` turns ending in an assistant turn with text `"DONE"`, calls `respondSubagentResult("c1")`, and asserts `respondPermission` was invoked with `("ps", <requestId>, { value: <contains "DONE"> })` (mock `ipc.respondPermission`). Assert the mapping is cleared afterward (`takeSubagentRequest("c1")` is `undefined`).

- [ ] **Step 2: Run it, verify it fails.** Run: `cd apps/desktop && bun test tests/store*.test.ts`. Expected: FAIL (`respondSubagentResult` undefined).

- [ ] **Step 3: Implement `respondSubagentResult`** (a module function near `deliverAndDrain`, store.ts ~2727):

```ts
// HOY-300: a finished child answers its parent's blocked agent-tool request with
// its result (in-band), replacing HOY-233's turn-injection delivery. The parent's
// ctx.ui.input resolves to this value and its turn continues with the result in
// context. The child stays a watchable thread; its panel auto-closes.
function respondSubagentResult(childThreadId: string): void {
  const req = takeSubagentRequest(childThreadId);
  if (!req) return; // not a sync child (or already answered)
  const state = useSessionStore.getState();
  const childTurns = state.turns[childThreadId] ?? [];
  const value = frameSubagentResult(
    findThread(state.projects, childThreadId)?.thread.spawnedBy?.type ?? "subagent",
    extractResultText(childTurns),
  );
  void respondPermission(req.parentSessionId, req.requestId, { value });
  // Stamp terminal + auto-close the child panel (parity with the old flow).
  useSessionStore.setState((s) => ({
    projects: patchThread(s.projects, childThreadId, (th) => ({
      ...th,
      completedAt: th.completedAt ?? Date.now(),
    })),
  }));
  useSessionStore.getState().closePanel(childThreadId);
}
```

Replace `void deliverAndDrain(threadId);` (store.ts:2225) with `respondSubagentResult(threadId);`.

- [ ] **Step 4: Run tests, verify pass.** Run: `cd apps/desktop && bun test && bun run check:ts`. Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/state/store.ts
git commit -m "HOY-300: a finished child answers its parent's blocked request in-band"
```

---

### Task 5: Concurrency — a parent blocked awaiting a child must not hold its slot

**Files:**
- Modify: `apps/desktop/src/state/store.ts`

**Rationale:** With blocking spawns, an intermediate subagent (depth ≥ 1) that holds a `runningAgents` slot while awaiting its own child can deadlock under a full concurrency cap (all slots held by agents blocked on queued descendants). Fix: when a child-agent issues a `subagentSpawnSync` (it is about to block), release its slot and pump the queue; when its child answers and it resumes streaming, it runs as a resume (already outside `runningAgents`, like the old resume path). Root/foreground parents are never in `runningAgents`, so they are unaffected.

**Interfaces:**
- Consumes: `runningAgents: Set<string>`, `pumpAgentQueue()` (store.ts:1017).
- Produces: in the `subagentSpawnSync` branch, before spawning: if `runningAgents.has(threadId)`, remove `threadId` and `pumpAgentQueue()`.

- [ ] **Step 1: Write the failing test.** Store test: put parent `p1` in `runningAgents`, dispatch a `subagentSpawnSync` event on `p1`, assert `runningAgents` no longer contains `p1` and a queued child (if any) was pumped. (Deadlock is the real target; this membership check is the observable proxy.)

- [ ] **Step 2: Run it, verify it fails.**  Run: `cd apps/desktop && bun test tests/store*.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In the `subagentSpawnSync` branch (Task 3), before calling `spawnChildThread`:

```ts
      // HOY-300: this parent is about to block on the child's result. If it holds
      // a concurrency slot (it is itself a running subagent), release it so the
      // child can start even under a full cap — a blocked agent isn't computing.
      if (useSessionStore.getState().runningAgents.has(threadId)) {
        useSessionStore.setState((s) => {
          const runningAgents = new Set(s.runningAgents);
          runningAgents.delete(threadId);
          return { runningAgents };
        });
        useSessionStore.getState().pumpAgentQueue();
      }
```

- [ ] **Step 4: Run tests, verify pass.** Run: `cd apps/desktop && bun test`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/state/store.ts
git commit -m "HOY-300: release a parent's concurrency slot while it blocks on a child (deadlock-safe)"
```

---

### Task 6: Remove the HOY-233 async-delivery layer

**Files:**
- Modify: `apps/desktop/src/state/delivery.ts`, `apps/desktop/src/state/store.ts`, `apps/desktop/src/components/ThreadView.tsx`, `apps/desktop/src/lib/types.ts`, `apps/desktop/tests/delivery.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `delivery.ts` keeps only `extractResultText`, `isSubagentThread`, `childThreadIdsOf`, `threadDepth`, `descendantThreadIdsOf`. All delivery/queue/defer/outstanding helpers are gone. `store.ts` no longer defines `deliverAndDrain`/`deliverToParent`/`deliveringParents`/`decrementOutstanding`, no longer maintains `outstandingChildren`/`pendingDeliveries`, and no longer injects a `subagentResult` user turn. `types.ts` drops the `subagentResult` turn `origin` and the `subagent` turn field.

- [ ] **Step 1: Delete the dead delivery code.** In `delivery.ts` remove `Delivery`, `NO_OUTPUT`-only-for-buildDelivery usage stays with `extractResultText`, `buildDelivery`, `pendingDeliveries`, `queueDelivery`, `takeNextDelivery`, `shouldDeliverToParent`, `shouldDecrementParentOnTeardown`, `shouldDeferUpDelivery`. In `store.ts` remove `deliverAndDrain`, `deliverToParent`, `deliveringParents`, `decrementOutstanding`, the `outstandingChildren` state + its increment in `spawnChildThread` (line ~989), and any `takeNextDelivery`/`queueDelivery` imports. Remove the `subagentResult` turn-injection block (it no longer exists after Task 4 replaced the call, but delete the now-unused imports).

- [ ] **Step 2: Remove the `subagentResult` turn rendering.** In `ThreadView.tsx` `UserTurn` (lines ~529-538) delete the `turn.origin === "subagentResult"` branch. In `types.ts` remove `origin?: "subagentResult"` and the `subagent?: {...}` field from the user `Turn`.

- [ ] **Step 3: Trim tests.** Delete tests in `delivery.test.ts` covering the removed helpers (`buildDelivery`, queue, defer, `shouldDeliverToParent`, `shouldDecrementParentOnTeardown`). Keep `extractResultText` + tree-helper tests.

- [ ] **Step 4: Verify.** Run: `cd apps/desktop && bun run check:ts && bun test && bunx oxlint src`. Expected: clean typecheck, green tests, no unused-symbol lint errors (a lingering unused import is the signal you missed a reference — fix at the source, not by re-adding the helper).

- [ ] **Step 5: Commit.**

```bash
git add -A apps/desktop/src apps/desktop/tests
git commit -m "HOY-300: remove the HOY-233 async-delivery layer (superseded by in-band results)"
```

---

### Task 7: Abort + teardown cancel the child cleanly

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (teardown/abort), verify `apps/desktop/src-tauri/src/sidecar.rs` `cancel_pending_ui`.

**Rationale:** When a parent turn is aborted, Rust's `cancel_pending_ui` (sidecar.rs:474) answers the blocked `ctx.ui.input` as cancelled → the `agent` tool returns the "stopped" note (Task 1). The child thread it spawned must also be stopped and its mapping cleared so a late child `done` doesn't answer a request that no longer exists.

**Interfaces:**
- Consumes: `takeSubagentRequest` (Task 3), the existing thread-teardown/stop path.
- Produces: on parent stop/teardown, stop each child whose `SubagentRequest.parentThreadId === parent` and `takeSubagentRequest(child)` to drop the mapping; `respondSubagentResult` is a no-op when the mapping is already gone (guarded in Task 4).

- [ ] **Step 1: Write the failing test.** Store test: record a request for child `c1` under parent `p1`, invoke the parent-stop path for `p1`, assert `c1`'s mapping is cleared (`takeSubagentRequest("c1")` is `undefined`) and the child stop was requested.

- [ ] **Step 2: Run it, verify it fails.** Run: `cd apps/desktop && bun test tests/store*.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `stopStreaming`/teardown for a parent thread, iterate children with a live mapping (a `childrenOfParent(parentThreadId)` scan over the map or `childThreadIdsOf(projects, parentThreadId)`), call the existing child-stop path and `takeSubagentRequest(childId)`. Guarantee `respondSubagentResult` early-returns when `takeSubagentRequest` yields `undefined` (already the case in Task 4).

- [ ] **Step 4: Run tests, verify pass.** Run: `cd apps/desktop && bun test && bun run check:ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/state/store.ts apps/desktop/tests
git commit -m "HOY-300: cancel the child + drop the mapping when the parent aborts"
```

---

### Task 8: Rebuild, live-verify, and update the plan-mode prompt note

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-system-prompt.ts` (PLAN_MODE_PROMPT subagent guidance — the "synthesize their findings" wording now matches the synchronous reality; drop any "delivered back later" phrasing in `AGENT_TOOLS_PROMPT` if present).

- [ ] **Step 1: Align the prompt.** In `hoy-system-prompt.ts`, ensure the agent-tool guidance says the subagent's result is *returned to you when it finishes* (not "delivered back as a later message"). Update the wording; add/adjust the `hoy-system-prompt.test.ts` assertion for the new phrasing.

- [ ] **Step 2: Rebuild the sidecar.** Run: `bash packages/sidecar/build.sh`. Expected: builds; `grep -c "spawn-subagent-sync" packages/sidecar/hoy-pi-*` ≥ 1 (via `command grep`, not the ugrep shell function).

- [ ] **Step 3: Full check.** Run: `cd apps/desktop && bun test && bun run check:ts && bunx oxlint src && cargo test --manifest-path src-tauri/Cargo.toml`. Expected: all green.

- [ ] **Step 4: Live-verify (running app, DeepSeek, `~/.hoyd` dev dir).** Launch `bun run tauri:dev`; in Plan mode ask for a multi-file plan that triggers Explore subagents. Confirm: (a) the parent's `agent` tool call shows the child's result as its tool result; (b) the child runs as a watchable nested thread; (c) the `<proposed_plan>` card is the **last** turn with actions, no trailing `subagent result` turns, no post-plan continuation; (d) two `agent` calls in one turn run concurrently and both results return; (e) aborting mid-child stops cleanly. Screenshot the terminal plan card.

- [ ] **Step 5: Commit + push.**

```bash
git add packages/sidecar/pi-src/hoy-system-prompt.ts packages/sidecar/pi-src/hoy-system-prompt.test.ts
git commit -m "HOY-300: align plan-mode/agent-tool prompt with synchronous subagent results"
git push origin HEAD
```

---

## Self-Review

**Spec coverage (HOY-300 ticket):**
- Blocking `ctx.ui.input` returning the child result in-band → Task 1. ✓
- Rust classify + `SubagentSpawnSync` event with `requestId` → Task 2. ✓
- Renderer spawns watchable child + records mapping → Task 3. ✓
- Child `done` answers the parent via `respond_permission`/`respond_ui` → Task 4. ✓
- Remove `deliverToParent`/auto-wake/FIFO queue/`subagentResult` turn/newest-first scan → Task 6 (newest-first `flagPlanReadyIfPresent` still finds a last-turn plan, so it's left working; the *concern* it addressed — trailing subagent turns — is gone). ✓
- Keep consent gate + depth cap → unchanged (Task 1 keeps the consent block; depth cap untouched). ✓
- Abort cancels request + kills child → Task 7. ✓
- Parallel subagents (concurrent, resolved in call order) → guaranteed by Pi (`toolExecution:"parallel"`), verified in Task 8 step 4d. ✓
- Deadlock-safety of blocking under the concurrency cap → Task 5 (not in the ticket text but required by the design; flagged). ✓

**Placeholder scan:** No "TBD"/"handle appropriately"; code blocks present for each code step. Task 6/7 reference exact symbols removed/added.

**Type consistency:** `SpawnPayload.requestId` (Task 3) is read in `spawnChildThread` (Task 3) and consumed by `recordSubagentRequest`→`takeSubagentRequest`→`respondSubagentResult` (Tasks 3-4). `SubagentRequest` fields (`parentThreadId`/`parentSessionId`/`requestId`) are consistent across Tasks 3, 4, 7. Rust `SubagentSpawnSync` field renames (`requestId`/`agentId`/`subagentType`) match the renderer event shape in `types.ts`/`ipc.ts` (Tasks 2-3). `SPAWN_SYNC_PREFIX` (TS) and `SPAWN_SYNC_PREFIX` (Rust) are the same literal.

**Open risk to watch during execution:** Task 5's deadlock rule assumes only `runningAgents` members hold slots; confirm no other path pins a blocked parent. If nested (depth-2) live tests reveal a stall, revisit whether a resumed parent should re-enter `runningAgents`.
