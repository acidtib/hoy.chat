# HOY-233: Subagents Phase 2, async result delivery + steering (design)

Builds directly on Phase 1 (HOY-231, shipped): the `agent` tool spawns a
first-class child thread (its own Rust-driven sidecar session), nested under the
parent, fire-and-forget. Phase 1 delivers no result back to the parent. Phase 2
closes that gap and confirms a running child is steerable.

Supersedes the Phase 2 sketch in
`docs/plans/HOY-231-subagent-infrastructure-design.md` (the "and/or" and "if
adopted here" open questions there are resolved below).

## Scope

Phase 2 is two things:

1. **Async result delivery to the parent (push / auto-resume)** — the net-new
   subsystem. When a child finishes, its result is injected back into the
   parent's context as a new, distinctly-rendered turn; if the parent is busy the
   result queues and drains when the parent goes idle. An idle parent auto-wakes
   and continues. This is the committed fully-async fire-and-forget model from
   Phase 1.
2. **Steering a running child** — verify + polish. The child is already a
   first-class thread with its own composer, and `enqueue_prompt` is keyed by
   `session_id`, so a human opening a running child and typing already steers it.
   The task is to live-verify that path works for spawned threads and fix only if
   it is broken. No new `steer` command.

### Explicitly deferred (own follow-ons)

- Background concurrency limiter (cap + queue + foreground bypass). Filed
  separately; Phase 2 spawns children unconditionally as Phase 1 does.
- Graceful `max_turns` (steer "wrap up" -> graceTurns -> abort).
- Pi's native `steer` RPC command (`{type:"steer"}` at `rpc-mode.js:317`, unused).
  `enqueue_prompt` with `streamingBehavior` already covers human steering.
- Programmatic parent-to-child steering (an agent steering its own child).
- Poll-style `get_agent_result`. Rejected in favor of push.

## Why push (auto-resume), not poll

Phase 1's brainstorm committed to "fully async / fire-and-forget: the result is
delivered back into the parent's context later, not awaited inline." A poll tool
(`get_agent_result`) requires the parent model to know to call back after it has
already returned, which does not fit fire-and-forget. Push injects the result the
moment the child finishes, so the parent progresses on its own. The surprise of an
idle parent waking up is mitigated by rendering the injected result as a clearly
marked subagent-result note, never as a fake human message.

## Architecture

All new logic is renderer-side, in `apps/desktop/src/state/store.ts`. No new Rust
`AgentEvent` and no new Tauri command are required: delivery reuses the existing
`Done` event (`sidecar.rs:427`) as the completion signal and the existing
`send_prompt` command to resume the parent sidecar. This keeps the Rust/sidecar
contract unchanged and confines Phase 2 to the layer that already owns spawning
(`spawnChildThread`).

Key existing facts this relies on (verified against the tree):

- A child's turn ends with `AgentEvent::Done`, a bare marker with no result
  payload (`events.rs:136`, emitted `sidecar.rs:427`). The child's full transcript
  is already assembled renderer-side in `turns[childThreadId]`, so the final
  assistant text is available when `done` fires.
- `streamPromptOnThread(threadId, sessionId, message, ...)` (`store.ts:1416`)
  creates a `Channel`, registers it in `activeChannels` (`store.ts:1408`), seeds a
  user turn plus a streaming assistant turn, sends a `prompt` to the sidecar, and
  deletes the channel on `done` (`store.ts:1481`). It is the shared path for
  `submitPrompt` and `spawnChildThread`.
- Sending a `prompt` to an idle session resumes it as a new turn; the parent
  sidecar stays alive between turns, so it can be resumed within the same runtime.
- `activeChannels.has(threadId)` is a reliable "this thread is currently
  streaming" check.

## Components

### 1. Result capture (child `done` handler)

In `streamPromptOnThread`'s `done` branch (`store.ts:1481`), after channel
cleanup, add: if the finishing thread has a `parentThreadId`, call
`deliverResultToParent(parentThreadId, finishingThread)`.

The result text is derived from the child's **final assistant turn**. If the child
ended in error or was aborted (the child's transcript carries an error turn / the
`aborted` marker), the result is a failure note instead of assistant text.

### 2. `deliverResultToParent(parentThreadId, childThread)` (new store action)

1. Build `resultText`:
   - success: the child's final assistant turn text (trimmed).
   - failure/abort: `Subagent <type> (<shortId>) failed: <message>` (or
     `... was stopped before finishing.` for abort).
2. Build the framed delivery string the parent sidecar receives, e.g.
   `[Subagent result -- <type> (<shortId>)]\n\n<resultText>`. This literal text is
   what Pi records as the parent's next user message and what the parent model
   reads.
3. **Busy check.** If `activeChannels.has(parentThreadId)` (parent mid-turn), push
   `{ delivery, seedRole, meta }` onto `pendingDeliveries[parentThreadId]` (a new
   `Map<string, DeliveryItem[]>` in the store) and return.
4. Otherwise deliver now:
   `streamPromptOnThread(parentThreadId, parentSessionId, delivery, { seedRole: "subagentResult", meta: { subagentType, agentId } })`.

If the parent thread has no live `sessionId` (e.g. never opened this runtime), the
delivery is dropped with a console warning; cross-restart delivery is out of scope
(see Edge cases).

### 3. Drain on parent idle

In the same `done` branch, after the parent's own turn completes: if
`pendingDeliveries[parentThreadId]` is non-empty, shift the next item and deliver
it via `streamPromptOnThread(...)`. Results drain **sequentially**, one parent turn
per child result, so each result is individually attributable and the parent
reacts to them in order.

### 4. Distinct rendering (`seedRole`)

`streamPromptOnThread` gains an optional final options arg
`{ seedRole?: "user" | "subagentResult"; meta?: {...} }` (default `"user"`),
threaded into the seeded turn. A `subagentResult` turn renders in `ThreadView`
as a marked note (muted styling, a `Subagent result -- <type>` label, the short
id), visually distinct from a user bubble. The message sent to the sidecar is
unchanged by `seedRole`; only the local turn's role/label differ. Pi still sees a
user message; the renderer just labels its origin.

### 5. Prompt / tool-text flip

- `hoy-agents.ts`: the `agent` tool's success return text changes from "its result
  does not return to you in this phase" to a statement that the subagent's result
  **will** be delivered back into this conversation when it finishes.
- `hoy-system-prompt.ts` `AGENT_TOOLS_PROMPT`: the "Its result does NOT come back
  to you" line flips to describe async delivery: the subagent runs independently
  and its result is delivered back into this conversation when it completes, so the
  model may keep working and will be resumed with the result.

## Data flow (happy path)

```
parent turn: model calls agent({subagentType:"Explore", task})
  -> consent -> notify sentinel -> Rust SubagentSpawned
  -> store.spawnChildThread: child Thread (parentThreadId set) + createSession
     + streamPromptOnThread(child)                       [Phase 1, unchanged]
  parent turn continues / ends (fire-and-forget)

child streams ... child `done` fires on child channel
  -> deliverResultToParent(parentThreadId, child)
     parent idle?  yes -> streamPromptOnThread(parent, ..., {seedRole:"subagentResult"})
                   no  -> pendingDeliveries[parent].push(...)

parent turn `done`
  -> pendingDeliveries[parent] non-empty? -> deliver next (sequential drain)
```

## Edge cases

- **Child error / abort:** delivered as a failure note, never silently dropped, so
  the parent is not left waiting.
- **Parent busy when child finishes:** queued, drained on the parent's next `done`.
- **Multiple children finish together:** all queue; drain sequentially, one parent
  turn each.
- **Parent auto-wake:** an idle parent receiving a delivery starts a new turn on
  its own; the marked rendering makes the origin unmistakable.
- **Cross-restart:** delivery happens only within a live runtime (parent sidecar
  alive). If the app restarts mid-child, both sidecars are gone and the user
  reopens threads manually, exactly as in Phase 1. No cross-restart delivery is
  built. Documented only.
- **Parent thread archived/closed but session alive:** delivery still resumes the
  session; the marked turn appears when the parent is next viewed. Acceptable.
- **Grandchild depth:** children have no `agent` tool (Phase 1 depth cap), so a
  delivered result cannot chain into deeper spawns beyond the existing cap. A
  parent acting on a delivered result may spawn new children (allowed, still
  depth-1).

## Steering (verify + polish)

The child is a first-class thread; opening it renders a `Composer` that calls the
same `submitPrompt` / `enqueue_prompt` path as any thread, keyed by the child's
`sessionId`. Steering a running child is therefore expected to already work
(`streamingBehavior: "steer"` mid-turn, `"followUp"` to queue). Phase 2 live-
verifies this for a spawned thread and fixes only if the composer path is broken
for children (e.g. missing `sessionId` wiring). No dedicated `steer` command, no
parent-to-child steering.

## Testing

Renderer unit tests (Vitest) for `deliverResultToParent` and drain, exercised
through the store with a stubbed `streamPromptOnThread`/`createSession`:

- idle parent -> immediate delivery with `seedRole:"subagentResult"`.
- busy parent (`activeChannels` has parent) -> queued; on parent `done`, drained.
- child error/abort -> failure note delivered, not assistant text.
- multiple queued deliveries -> drained sequentially, one per parent `done`.
- delivery derives text from the child's final assistant turn.

Sidecar tests:

- `hoy-system-prompt.test` (wherever `buildHoySystemPrompt` is asserted): the
  agent block now states the result is delivered back; the stale "does NOT come
  back" wording is gone.

Live-verify in the running app via the Tauri bridge:

- parent spawns an Explore child; on completion the child's findings appear in the
  parent thread as a marked subagent-result note and the parent continues;
- steer a running child from its composer and see the child react;
- restart persistence unchanged (children still nest and reopen).

## Files (for writing-plans to expand)

Renderer:
1. `apps/desktop/src/state/store.ts`: `pendingDeliveries` map;
   `deliverResultToParent`; child-`done` hook to call it; parent-`done` drain;
   `streamPromptOnThread` gains `{ seedRole?, meta? }`; seed the turn with the
   role.
2. `apps/desktop/src/lib/types.ts`: turn role/`meta` addition for
   `subagentResult` (mirror any persisted shape).
3. `apps/desktop/src/components/ThreadView.tsx` (+ turn/message component):
   render a `subagentResult` turn as a marked note.

Sidecar (TypeScript):
4. `packages/sidecar/pi-src/hoy-agents.ts`: flip the `agent` tool success text.
5. `packages/sidecar/pi-src/hoy-system-prompt.ts`: flip `AGENT_TOOLS_PROMPT`.
6. The `buildHoySystemPrompt` test file: update the assertion.

Verification:
7. `packages/sidecar/build.sh` rebuild; renderer + sidecar unit tests green;
   live-verify per above; commit `HOY-233:` with evidence.
