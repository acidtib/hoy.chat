# Goal Mode (HOY-263) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/goal <condition>` sets a completion condition and Hoy keeps working across turns until a cheap tool-less evaluator judges the condition met from the transcript, or a hard turn cap terminates the loop.

**Architecture:** Renderer-owned continuation loop (each iteration is a normal prompt, so the per-prompt sink lifecycle in `route_message` is untouched) plus a one-shot sidecar evaluator invocation (same binary, mirrors `HOY_LIST_SUBAGENTS`). Full rationale and the decision record: `docs/plans/HOY-263-goal-mode-design.md`. Read it first.

**Tech stack:** Tauri v2 (Rust), React + TypeScript + Zustand, Bun; Pi as a spawned sidecar over JSONL-over-stdio RPC.

## Global constraints

- No emojis and no em-dashes (`--`) anywhere: code, comments, docs, commit messages.
- Plain commit messages, prefixed `HOY-263:`. No Co-Authored-By trailers.
- No new runtime dependencies. No Vercel AI SDK, no `ai`/`@ai-sdk/*`.
- Keep the `AgentEvent` union and Rust/TS command signatures in sync when either changes (`events.rs` <-> `types.ts`, `commands.rs` <-> `lib/ipc.ts`). This plan adds one command (`evaluate_goal`); no new `AgentEvent` variant.
- The sidecar binary is stale until rebuilt: `packages/sidecar/build.sh` must run before any live verification of Task 2 or the branch.
- `GOAL_DEFAULT_CAP_TURNS` is a named constant, colocated with the goal model in `apps/desktop/src/state/goal.ts`. Do not scatter magic numbers.
- Goal transient state (`turns`, `tokensUsed`, `lastReason`, continuation-pending guard) is NOT persisted; only the workspace `Thread.goal` snapshot is, matching how `completedAt` is treated.

---

### Task 1: Renderer goal domain model + reducer (pure)

Pure types, constants, and a reducer that decides the next action after a turn. No Tauri, fully unit-testable. No behavior change yet.

**Files:**
- Create: `apps/desktop/src/state/goal.ts`
- Create: `apps/desktop/src/state/goal.test.ts`

**Interfaces:**
- Produces: `ThreadGoal` type, `GoalStatus`, `GOAL_DEFAULT_CAP_TURNS`, `parseGoalCommand(raw): GoalCommand | null`, `nextGoalAction(goal, turnOutcome): GoalAction`.

- [ ] **Step 1: Define the model and command parser**

`ThreadGoal = { condition: string; status: GoalStatus; turns: number; tokensBaseline: number; tokensUsed: number; startedAt: number; capTurns: number; evaluatorModel?: ModelRef; lastReason?: string }`. `GoalStatus = "active" | "paused" | "met" | "capped" | "cleared"`. `GOAL_DEFAULT_CAP_TURNS = 25`.

`parseGoalCommand(raw: string)` maps composer input to `{ kind: "set", condition } | { kind: "status" } | { kind: "pause" } | { kind: "resume" } | { kind: "clear" }`. Recognize `/goal` (status), `/goal <text>` (set, condition trimmed, reject > 4000 chars), `/goal pause|resume`, and `/goal clear|stop|off|reset|none|cancel` (clear aliases). Return `null` if the input is not a `/goal` command.

- [ ] **Step 2: Define the reducer `nextGoalAction`**

Given the current `goal` and a `turnOutcome = { aborted: boolean; errored: boolean; hasPendingUserPrompt: boolean; tokensNow: number }`, return a pure `GoalAction`:
- goal missing or not `active` -> `{ type: "none" }`.
- `aborted || errored` -> `{ type: "pause" }`.
- `turns + 1 >= capTurns` -> `{ type: "cap", turns: turns + 1 }`.
- `hasPendingUserPrompt` -> `{ type: "yield" }` (stay active, let the user turn run).
- otherwise -> `{ type: "evaluate", turns: turns + 1, tokensUsed: tokensNow - tokensBaseline }`.

The evaluator result then maps (a second pure helper `applyEvaluation(goal, { met, reason })`) to `{ type: "met", reason } | { type: "continue", reason }`.

- [ ] **Step 3: Write failing tests**

`goal.test.ts`, matching the `test(...)` style in `apps/desktop/src/state/delivery.test.ts`. Cover: parser for each subcommand + aliases + the 4000-char reject + non-goal input returns null; reducer for none/paused, aborted-pauses, cap boundary (exactly at `capTurns`), pending-user-yields, the normal evaluate path with correct `tokensUsed`; `applyEvaluation` met vs continue.

- [ ] **Step 4: Run tests, verify they fail, implement, verify they pass**

Run: `cd apps/desktop && bun test ./src/state/goal.test.ts` (fail first, then all pass) and `bun run check:ts` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/state/goal.ts apps/desktop/src/state/goal.test.ts
git commit -m "HOY-263: goal domain model, command parser, and pure loop reducer"
```

---

### Task 2: Sidecar one-shot evaluator + Rust command + ipc wrapper

A short-lived sidecar invocation that judges the transcript against the condition with a cheap tool-less model. Mirrors the existing `HOY_LIST_SUBAGENTS` one-shot. Requires a sidecar rebuild before live-verify.

**Files:**
- Create: `packages/sidecar/pi-src/hoy-goal-eval.ts`
- Modify: `packages/sidecar/pi-src/hoy-sidecar.ts` (add the one-shot branch near `:77`, next to the `HOY_LIST_SUBAGENTS` branch)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (new `evaluate_goal` command) and `apps/desktop/src-tauri/src/lib.rs` (register in `generate_handler!`, `:99`)
- Modify: `apps/desktop/src-tauri/src/sidecar.rs` (a helper to spawn the one-shot and capture stdout, mirroring the `list_subagents` spawn path at `:1080` - `.env("HOY_LIST_SUBAGENTS","1")` at `:1092`, stdout parsed at `:1098-1103`)
- Modify: `apps/desktop/src/lib/ipc.ts` (typed `evaluateGoal` wrapper)

**Interfaces:**
- Consumes: the session file for the thread, the condition, an optional evaluator model.
- Produces: `evaluateGoal(sessionId, condition, evaluatorModel?) -> { met: boolean; reason: string }`.

- [ ] **Step 1 (SPIKE): pick the one-off completion API**

Read `packages/sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent/dist/core/{model-registry,sdk,agent-session}.d.ts`. Decide between (a) a direct `modelRegistry` completion call and (b) a throwaway `SessionManager.inMemory` session prompted once with `tools: []` and compaction disabled (the `tmonk` auditor shape). Record the chosen call in a comment at the top of `hoy-goal-eval.ts`. Fail open: any error or unparseable output yields `{ met: false, reason: "evaluator error: <detail>" }`.

- [ ] **Step 2: Implement the one-shot entry**

`hoy-goal-eval.ts` reads `HOY_GOAL_CONDITION`, opens the transcript via `SessionManager.open(process.env.HOY_SESSION_FILE)`, takes the last N messages (cap total tokens), builds the strict-evaluator prompt (judge ONLY from surfaced evidence, no tools, return `{ met, reason }` JSON, treat uncertainty as not met), runs the chosen model (honoring `HOY_GOAL_EVAL_MODEL` if set), parses `{ met, reason }` (JSON with a regex fallback), writes the JSON to stdout, and exits 0.

In `hoy-sidecar.ts`, next to the `HOY_LIST_SUBAGENTS` block (`:77`), add:
```ts
if (process.env.HOY_GOAL_EVAL) {
  await runGoalEval(agentDir, process.cwd());
  // runGoalEval writes JSON to stdout and exits.
}
```
Import `runGoalEval` from `./hoy-goal-eval`. Keep it before `createAgentSessionRuntime` so it never reaches `runRpcMode`.

- [ ] **Step 3: Rust command that spawns the one-shot**

In `sidecar.rs`, add a helper mirroring the `list_subagents` spawn (`fn list_subagents` at `:1080`): build the sidecar `Command` with `apply_sanitized_env`, set `HOY_GOAL_EVAL=1`, `HOY_GOAL_CONDITION=<condition>`, `HOY_SESSION_FILE=<thread session file>`, `HOY_CODING_AGENT_DIR`, and (if provided) `HOY_GOAL_EVAL_MODEL`; capture stdout; parse the JSON into a `GoalEvaluation { met: bool, reason: String }`. In `commands.rs`, add `#[tauri::command] async fn evaluate_goal(state, session_id, condition, evaluator_model: Option<String>) -> Result<GoalEvaluation, String>` that resolves the session's file and calls the helper. Register `evaluate_goal` in `lib.rs` `generate_handler!` (`:99`).

- [ ] **Step 4: ipc wrapper**

In `lib/ipc.ts`, add `evaluateGoal(sessionId: string, condition: string, evaluatorModel?: ModelRef): Promise<GoalEvaluation>` wrapping `invoke("evaluate_goal", { sessionId, condition, evaluatorModel })`. Add the `GoalEvaluation` type to `lib/types.ts`.

- [ ] **Step 5: Rebuild, typecheck, build**

Run: `bash packages/sidecar/build.sh` (must succeed and assert the branded config dir), then `cd apps/desktop && bun run check:ts` (exit 0) and `cd src-tauri && cargo build` (compiles).

- [ ] **Step 6: Live-verify the evaluator in isolation**

With a thread that has run a couple of turns, call `evaluateGoal` from the tauri MCP bridge against a clearly-true and a clearly-false condition; confirm `{ met, reason }` matches. Confirm the chosen evaluator model is the cheap one (log it).

- [ ] **Step 7: Commit**

```bash
git add packages/sidecar/pi-src/hoy-goal-eval.ts packages/sidecar/pi-src/hoy-sidecar.ts apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/sidecar.rs apps/desktop/src/lib/ipc.ts apps/desktop/src/lib/types.ts
git commit -m "HOY-263: one-shot transcript evaluator and evaluate_goal command"
```

---

### Task 3: Persist `Thread.goal` (workspace)

Make a goal survive restart/reopen so the card renders before a sidecar spawns and resume can restore the condition.

**Files:**
- Modify: `apps/desktop/src/lib/types.ts` (`Thread`, `:376`)
- Modify: `apps/desktop/src-tauri/src/workspace.rs` (the `WsThread` mirror, `:41`, inside `WsProject.threads`)
- Modify: `apps/desktop/src/state/store.ts` (partialize/serialize the goal; reset counters on load)

**Interfaces:**
- Produces: `Thread.goal?: ThreadGoal` persisted through `saveWorkspace`; on load, `turns`/`startedAt`/`tokensBaseline` reset (Claude Code resume semantics), `status` demoted `active -> paused` so a restored goal does not auto-run until the user resumes.

- [ ] **Step 1: Add the field both sides**

Add `goal?: ThreadGoal` to the TS `Thread` and a matching optional field to the Rust `WsThread` struct (`workspace.rs:41`, serde camelCase). Keep the shapes in sync (AGENTS.md).

- [ ] **Step 2: Load semantics**

Where the workspace is loaded into the store (`loadWorkspace` path), for any restored `goal` with `status === "active"`, set `status = "paused"`, `turns = 0`, `startedAt = Date.now()`, and recompute `tokensBaseline` on resume. A goal with `status in { met, cleared }` is dropped.

- [ ] **Step 3: Typecheck, build, commit**

Run: `cd apps/desktop && bun run check:ts && bun run build`; `cd src-tauri && cargo build`.
```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src-tauri/src/workspace.rs apps/desktop/src/state/store.ts
git commit -m "HOY-263: persist Thread.goal, reset counters and pause on resume"
```

---

### Task 4: Composer `/goal` command handling

Intercept `/goal` in the composer and route to the store, so it never sends as an agent prompt.

**Files:**
- Modify: `apps/desktop/src/state/store.ts` - the `submitPrompt` action (declared `:511`, impl `:1211`) is where slash interception already happens: `/compact` is caught by a regex at `:1229-1234` before the prompt path, and every other `/` flows to Pi. Add the `/goal` interception here, following the `/compact` precedent exactly. Also add the new actions: `setGoal`, `pauseGoal`, `resumeGoal`, `clearGoal`, `showGoalStatus`.
- Reference only (no change required for interception): `apps/desktop/src/components/Composer.tsx` owns the `/` autocomplete picker (`detectSlash` import `:37`, `SLASH_BUILTINS` `:59`, `insertSlash` `:485`); `apps/desktop/src/lib/slash.ts` (`detectSlash` `:15`) is the caret detection primitive. Add `goal` to the picker's builtin list so it autocompletes, but the authoritative interception is in `store.submitPrompt`.

**Interfaces:**
- Consumes: `parseGoalCommand` (Task 1).
- Produces: goal store actions; `/goal ...` handled locally.

- [ ] **Step 1: Intercept in `store.submitPrompt`**

In `submitPrompt` (`store.ts:1211`), alongside the `/compact` intercept (`:1229-1234`), run `parseGoalCommand(input)`. If non-null, dispatch the matching store action and return before the prompt path (do not send it to Pi). This is the same shape as the existing `/compact` branch, so it inherits the correct composer-clear/turn-serialization behavior.

- [ ] **Step 2: Store actions**

`setGoal(threadId, condition)`: build a `ThreadGoal` (`status: active`, `turns: 0`, `tokensBaseline` from current thread token total via `getSessionStats`/existing token state, `capTurns: GOAL_DEFAULT_CAP_TURNS`), write it onto the thread, then send `condition` as the first prompt through the normal path. `pauseGoal`/`resumeGoal` flip status (resume sends a continuation, see Task 5). `clearGoal` sets `status: cleared` and removes it (does not abort an in-flight turn). `showGoalStatus` surfaces a notice/toast with condition/status/turns/tokens/elapsed/lastReason.

- [ ] **Step 3: Typecheck, build, commit**

Run: `cd apps/desktop && bun run check:ts && bun run build && bun test`.
```bash
git add apps/desktop/src/state/store.ts apps/desktop/src/components/Composer.tsx
git commit -m "HOY-263: intercept /goal in submitPrompt and add goal store actions"
```

---

### Task 5: The continuation loop (done handler)

Wire the reducer into the `done` handler so an active goal drives the next turn.

**Files:**
- Modify: `apps/desktop/src/state/store.ts` (the `done` branch at `:1996`)

**Interfaces:**
- Consumes: `nextGoalAction`/`applyEvaluation` (Task 1), `evaluateGoal` (Task 2).
- Produces: the auto-continuation. A continuation-pending guard prevents double-send.

- [ ] **Step 1: Hook the done handler**

In the `done` branch (`store.ts:1996`, `else if (event.kind === "done")`), after the existing `stopStreaming`/cleanup, if the thread has a `goal.status === "active"`:
1. Build `turnOutcome` from the finished turn (`aborted` from `turn.aborted` / any `Error` this turn; `hasPendingUserPrompt` from the thread's queued input; `tokensNow` from refreshed stats).
2. Call `nextGoalAction(goal, turnOutcome)` and switch:
   - `none|yield`: do nothing (yield leaves the goal active).
   - `pause`: set `status: paused`.
   - `cap`: set `status: capped`, `turns`.
   - `evaluate`: set a `continuationPending[threadId]` guard, `await evaluateGoal(sessionId, goal.condition, goal.evaluatorModel)`, re-read the goal (abort if no longer active/same condition), then `applyEvaluation`: on `met` set `status: met` + `lastReason`; on `continue` set `lastReason` and call `sendPrompt` with the continuation text. Clear the guard in a `finally`.
3. Respect the guard: if `continuationPending[threadId]` is set, skip (idempotency against a double `done`).

- [ ] **Step 2: Continuation prompt text**

A short, visually-distinct message: `Keep working toward the goal: <condition>.\nEvaluator (not yet met): <reason>.\nContinue with the next concrete step; do not stop until it is demonstrably met.` Send via the existing `sendPrompt` path so it gets a fresh sink.

- [ ] **Step 3: Live-verify the loop end-to-end** (needs the sidecar from Task 2 built)

Run `bun run tauri:dev`, DeepSeek as the live model, agent dir `~/.hoyd/agent`. Set a small verifiable goal (e.g. "a file `SCRATCH.md` exists containing the word DONE, or stop after 3 turns"). Confirm: turns auto-continue, the evaluator reason shows each turn, the loop stops on met, and a false condition stops at the cap. Confirm hitting stop pauses the goal (no relaunch), and a queued user message runs before the next continuation.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/state/store.ts
git commit -m "HOY-263: renderer-owned goal continuation loop in the done handler"
```

---

### Task 6: Goal card UI (reconcile with HOY-258)

Render goal status and an active indicator from `Thread.goal`.

**Files:**
- Create: `apps/desktop/src/components/GoalCard.tsx` (or an ai-elements card)
- Modify: `apps/desktop/src/components/ThreadView.tsx` (mount the card near the thread footer). NOTE: there is no existing working/streaming indicator in `ThreadView.tsx` to reconcile against - `:484-491` is an `ApprovalCard`, and HOY-258 is not merged. Mount the card by locating the thread footer/composer region at implementation time, not a fixed line. If HOY-258 has landed by then, fold the goal indicator into it (see design doc, "Note on HOY-258"); otherwise ship the card's own compact active indicator.

**Interfaces:**
- Consumes: `Thread.goal` store state.
- Produces: a card showing condition, status, elapsed (live tick), turns, tokens, last reason, and pause/resume/clear controls; a compact active indicator.

- [ ] **Step 1: Build the card**

Match the square theme and existing card styling (shadcn/ui + AI Elements). Live-tick elapsed with a single interval while `status === "active"`. Wire pause/resume/clear buttons to the Task 4 actions.

- [ ] **Step 2: Reconcile HOY-258 (only if it has landed)**

HOY-258 is a sibling ticket and may not be merged when this ships. If it is NOT merged, skip reconciliation and ship the goal card's own compact active indicator (pulsing-dot/shimmer). If it IS merged, the goal active indicator and the HOY-258 "working" indicator must be one coherent surface, not two competing spinners: when a goal is active the working indicator reads as "working toward goal"; otherwise it is the plain HOY-258 indicator. Keep the style consistent.

- [ ] **Step 3: Typecheck, build, screenshot, commit**

Run: `cd apps/desktop && bun run check:ts && bun run build`. Screenshot the card in active/paused/met states via the tauri MCP bridge.
```bash
git add apps/desktop/src/components/GoalCard.tsx apps/desktop/src/components/ThreadView.tsx
git commit -m "HOY-263: goal status card and reconciled working indicator"
```

---

## Whole-branch verification (after all tasks)

1. Final whole-branch review (most capable model) over `git merge-base main HEAD..HEAD`.
2. Rebuild the sidecar: `bash packages/sidecar/build.sh`.
3. Live-verify with `bun run tauri:dev`, the tauri MCP bridge, DeepSeek, agent dir `~/.hoyd/agent`:
   - `/goal <verifiable condition>` runs to met and clears; the card shows turns/tokens/elapsed/reason.
   - A false condition stops exactly at `GOAL_DEFAULT_CAP_TURNS` (temporarily lower it to force the path quickly, then restore).
   - Stop/abort pauses the goal; `/goal resume` continues; `/goal clear` wipes it.
   - A user message typed mid-loop runs before the next continuation.
   - Restart the app with an active goal: it restores paused with reset counters and resumes on demand.
4. `bun test` and `cargo test` green; `AgentEvent`/command contracts in sync; no emojis/em-dashes; commits prefixed `HOY-263:`.
