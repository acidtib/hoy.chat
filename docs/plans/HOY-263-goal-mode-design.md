# Goal Mode (HOY-263) Design

Ticket: HOY-263. Related: HOY-258 (persistent "working" indicator; the goal card is its goal-scoped form).

## Summary

Let a user set a completion condition with `/goal` and have Hoy keep working across turns until an evaluator confirms the condition holds. The user states an objective once instead of typing "continue" every turn. This is the Claude Code `/goal` and zcode `/goal` capability.

The loop is: after a turn ends, a cheap evaluator model judges the transcript against the condition; if not met it re-injects a continuation to run another turn; if met the goal clears. A hard turn cap always terminates the loop.

## Prior art (studied; see the research notes in the ticket thread)

- Claude Code `/goal`: a session-scoped prompt-based Stop hook. After each turn a small fast model (Haiku by default), tool-less, judges the transcript and returns yes/no plus a reason. The reason feeds the next turn. This is the model we copy.
- zcode `/goal`: same idea, richer command set (set/replace/pause/resume/clear) and a summary panel (status, elapsed, tokens, iterations).
- Pi extensions `narumiruna/pi-goal`, `fitchmultz/pi-codex-goal`, `tmonk/pi-goal-x`: all hook Pi's turn/agent-end events and re-inject a hidden continuation via `sendUserMessage`/`sendMessage`. Their hard-won correctness pieces (idle gating, goal-id-stamped continuation lock, stale-continuation guard, interrupt-pauses-the-loop, empty-turn guard) are the reference for the loop invariants below. None ship a hard iteration cap; we do.
- The single most useful artifact is `narumiruna/pi-extensions/docs/implementation-notes/pi-goal-interruption-research.md`: continuation policy must be owned where idle/interrupt state is authoritative. In Hoy that is the renderer, which already owns per-thread `streaming` / `abort` / `done` state. Hence the renderer-owned continuation below.

## Architecture decision

Two layers, split along a hard constraint in our RPC bridge.

### The constraint

`apps/desktop/src-tauri/src/sidecar.rs::route_message` (`:553-568`): on `agent_end`, unless Pi is auto-retrying (`willRetry`), Rust does `guard.take()` and emits `AgentEvent::Done`, which detaches the renderer sink. Subsequent events map to `None` sink and are dropped (`:571-575`). So a continuation injected from inside the sidecar after `agent_end` would stream into a detached sink and the renderer would go dark.

### Decision: renderer-owned loop, sidecar-owned evaluator

- **Continuation is renderer-owned.** On `done` for a thread with an active goal (store `done` handler, `apps/desktop/src/state/store.ts:1859`), the store runs the evaluator and, if not met, sends the next turn as an ordinary prompt via the existing `sendPrompt` path. Each iteration therefore gets a fresh per-prompt sink; `route_message` is untouched. Idle-gating, interrupt-to-pause, and turn serialization fall out of the renderer's existing machinery.
- **The evaluator is a one-shot sidecar invocation.** Rust spawns the same sidecar binary with `HOY_GOAL_EVAL=1` plus the condition, mirroring the existing `HOY_LIST_SUBAGENTS` (`packages/sidecar/pi-src/hoy-sidecar.ts:76`) and OAuth (`:68`) one-shots. It opens the session transcript (`HOY_SESSION_FILE`), runs a cheap tool-less model, prints `{ met, reason }` JSON to stdout, and exits. Not a new or persistent process; the same short-lived pattern already in the tree. It can use a cheaper model than the main session for free.

### Alternative considered (deferred): sidecar-extension-owned loop

A `createHoyGoal` extension owning the whole loop (continuation + evaluator in-process via `ctx.modelRegistry`), matching the three reference extensions and riding Pi session persistence/compaction/fork. Rejected for v1 because it requires changing the `agent_end`/sink teardown in `route_message` (keep the sink alive across goal continuations, analogous to `willRetry`, gated by a per-session goal-active flag Rust learns from the extension). That is the most delicate part of the bridge (see the HOY-188 keep-alive findings) and not worth the risk for v1. Revisit if we later want goal loops to run headless without the renderer.

## Loop model

Goal state per thread: `{ condition, status, turns, tokensBaseline, tokensUsed, startedAt, capTurns, evaluatorModel?, lastReason? }`. `status in { active, paused, met, capped, cleared }`.

- **Set** (`/goal <condition>`): store the goal `active`, `turns = 0`, `tokensBaseline = current thread token total`, then send `condition` as the first prompt. If a goal is already active, replace it. Recommend (do not force) `autonomous`/`acceptEdits` in the UI so iterations are not gated per tool.
- **On `done`** for a thread whose goal is `active`:
  1. If the finished turn was aborted or errored (`turn.aborted`, or an `Error` event this turn), set `status = paused` and stop. A user interrupt must not relaunch the loop.
  2. `turns += 1`; refresh `tokensUsed`. If `capTurns` reached, set `status = capped` and stop.
  3. If the user has a pending queued prompt on this thread, yield to it (do not continue this tick; the goal stays active and re-checks after the user's turn).
  4. Run the evaluator over the session. Re-read goal state after the async returns (it may have been cleared/paused/replaced); if no longer `active` for the same condition, abort this continuation.
  5. If `met`: set `status = met`, record `lastReason`, stop (leave an achieved marker in the transcript).
  6. Else: set `lastReason`, and send the continuation prompt (a short, visually-distinct "Keep working toward: <condition>. Evaluator: <reason>") via `sendPrompt`, which starts the next turn.
- **Pause / resume / clear**: renderer state. Resume from `paused`/`capped` re-arms and sends a continuation. Clear wipes goal state; it does not abort an in-flight turn.
- **Interrupt**: the existing abort path already stops the turn; the `done`/aborted handling in step 1 flips the goal to `paused`.

### Invariants (ported from the reference extensions)

- One continuation in flight per thread (the renderer serializes turns per thread already; add an explicit "continuation pending" guard so a stray double-`done` cannot double-send).
- Re-read goal state after the async evaluator before sending (guard against clear/replace during evaluation).
- User input always wins over auto-continuation (step 3).
- A hard `capTurns` (default, see below) guarantees termination even if the evaluator never returns `met`.

## Evaluator

A one-shot judge, tool-less, over the transcript (Claude Code's design):

- Input: the condition and the session transcript (last N messages; cap the token size).
- Prompt: strict completion evaluator. Judge ONLY from evidence the agent surfaced in the transcript; you cannot run tools or read files. Return a JSON object `{ met: boolean, reason: string }`. Treat uncertainty as not met.
- Output: parse `{ met, reason }` (JSON, with a regex/marker fallback). Any parse failure or model error is treated as not met with a diagnostic reason (fail open to "keep working", never falsely "met").
- Model selection: `goal.evaluatorModel` if configured, else a heuristic pick over available models whose id/name matches `haiku|mini|flash|small|lite|nano`, else fall back to the session's main model. Resolve via `resolveModelRef` (`store.ts:2285`). No native "cheap" flag exists on `ModelInfo`.

The exact SDK call to run a one-off completion in the one-shot invocation is the one open spike (Task 2, Step 1): read `packages/sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent/dist/core/{model-registry,sdk,agent-session}.d.ts` and pick between a direct `modelRegistry` completion and a throwaway in-memory `SessionManager.inMemory` session prompted once with no tools (the `tmonk` auditor uses the latter shape).

## State and persistence

- **UI-durable**: add `goal?: ThreadGoal` to `Thread` (`apps/desktop/src/lib/types.ts:375`) and mirror it in the Rust `Workspace` (`apps/desktop/src-tauri/src/workspace.rs`), persisted through `saveWorkspace`. This is what lets the goal card render on restart/reopen before any sidecar spawns, and is what "resume restores the condition, resets counters" reads from (reset `turns`/`startedAt`/`tokensBaseline` on load, per Claude Code's semantics).
- **Transient**: `turns`, `tokensUsed`, `lastReason`, and the continuation-pending guard live in the store and are recomputed; they do not need to persist beyond the workspace snapshot.
- No sidecar session `appendEntry` is required for v1 (the renderer owns state). It stays available if we later move to the extension-owned architecture.

## Command surface (v1)

Handled renderer-side in the composer (a Hoy-level command, not a Pi agent command), so it never round-trips as an agent prompt:

- `/goal <condition>` set or replace, up to 4000 chars, starts a turn immediately.
- `/goal` show status (condition, status, turns, tokens, elapsed, last reason).
- `/goal pause` / `/goal resume`.
- `/goal clear` (aliases `stop`, `off`, `reset`, `none`, `cancel`).

The composer already has slash handling for the `@`/`/` pickers (HOY-220/HOY-223); `/goal` is intercepted there before the prompt is sent.

## UI

A goal card (condition, running state, elapsed, turns, tokens, last evaluator reason) rendered from the renderer's `Thread.goal` state, plus a compact active indicator. Because the renderer owns goal state, no new `AgentEvent` variant is needed for the card (this supersedes the ticket's earlier "new GoalUpdate event" phrasing). Build it together with HOY-258: the goal card is the goal-scoped version of that "still working" indicator, and the two must not render as competing spinners.

## Verification-strength roadmap

- v1 (this ticket): cheap tool-less evaluator over the transcript.
- v2: optional deterministic command gate. Before declaring met, run a configured command (typecheck/test) and require exit 0. Ground truth for "tests pass"-style conditions.
- v3: optional independent read-only auditor subagent (our existing depth-capped subagent machinery) for conditions the transcript cannot prove.

## Risks and open questions

- **Evaluator SDK call** (Task 2 spike): confirm the one-off completion API in the pinned SDK. Fallback is a throwaway in-memory session.
- **Visible continuation message**: the continuation renders as a user-ish turn. Acceptable for v1 (all reference extensions do this); style it distinctly and consider hiding it from the transcript later.
- **Evaluator provider/cost**: it runs on the session's provider by default; a mis-picked "cheap" model could be a full-price model. Log the chosen evaluator model; make it configurable.
- **Transcript size**: cap the messages sent to the evaluator to bound cost and context.
- **Condition quality**: the evaluator can only judge surfaced evidence. Surface guidance in the UI ("state a check the agent can prove, e.g. `npm test` exits 0").

## Out of scope (v1)

Multi-goal per thread, subtask lists, the objective-sharpening questionnaire (we already have `ask_question`, HOY-253), the v2 command gate and v3 auditor, and headless (renderer-less) goal loops.
