# HOY-231: Subagent infrastructure, FleetView-native (design)

Supersedes the "Approach (decided)" section of the HOY-231 ticket and the
Mechanism A recommendation in `docs/plans/HOY-213-subagent-driven-planning-findings.md`.
That findings doc stays valid as the landscape survey (the four community
packages, the two spawn models, the security posture, the HOY-213 plan-agent
layer). What changes is the mechanism and the phasing: we are building the
FleetView-native async design the findings doc deferred to v2, not the in-process
nested-session v1 it recommended.

## The direction change

The findings doc recommended Mechanism A: run subagents as in-process nested
`createAgentSession` calls inside the parent sidecar, tag their events with a
child `sessionId` so the renderer *can* surface them, and defer "promote
subagents to first-class Rust-spawned sessions (FleetView)" to v2. That keeps the
parent's `agent` tool call simple (it awaits an in-process child and returns its
text) at the cost of subagents never being real, independent, steerable threads.

Decision (reversing that): **a subagent IS a first-class thread.** It is the same
thing as a user thread, a Rust-spawned sidecar session driven over RPC, except it
is spawned by an agent instead of by a person. This is cleaner long term (one
session abstraction, not two) and it is what makes the concurrent, observable,
steerable multi-agent product real. The findings doc's own "Alternatives
considered" calls this "the right shape for the v2 FleetView endgame"; we are
committing to it now.

The orchestration model is **fully async / fire-and-forget**: the parent spawns a
subagent and keeps working immediately; the subagent runs concurrently as its own
thread; its result is delivered back into the parent's context later, not awaited
inline.

This is several independent subsystems, so it ships in phases. Each phase is
independently shippable and live-verifiable, and each de-risks the next.

## Phases

- **Phase 1 (this ticket, HOY-231): the spawn channel + first-class child
  sessions.** The new sidecar to Rust control path, Rust-driven child sidecar
  sessions, child threads nested under the parent in the sidebar, two hardcoded
  built-in types. No result-to-parent yet.
- **Phase 2 (follow-on): async result delivery + steering.** `get_agent_result`
  (parent polls) and/or Rust injecting a completion message into the parent
  session; `steer_agent` into a running child; background lifecycle + concurrency
  limiter. This is what makes fire-and-forget actually useful to the parent agent.
- **Phase 3 (follow-on): agent-type registry + safety.** `.hoy/agents/*.md`
  discovery (project + global, project wins), YAML frontmatter
  (tools/model/thinking/prompt_mode/max_turns/...), per-type consent,
  `project_trust` gating of project-scope defs, depth/fanout guards. Generalizes
  Phase 1's two hardcoded built-ins into the registry.
- **Phase 4 (follow-on): the FleetView panel.** The dedicated multi-agent surface:
  live tiles per running subagent, steer boxes, parent/child visualization beyond
  a sidebar nest.
- **Phase 5 (follow-on, = HOY-213): the first real consumer.** The `Plan` agent
  type on top of the stack, plus the plan to execution handoff.

Follow-on tickets get filed once Phase 1 lands; this doc specs Phase 1 only.

---

## Phase 1 design

### Success criteria (definition of done)

Parent agent calls `agent({ subagentType, task })` in a thread, a first-time
consent prompt appears, and on Allow a new child thread appears nested and
collapsed under the parent, runs the task to completion in its own visible
streaming transcript, and persists across an app restart. The spawn is
renderer-orchestrated, so end-to-end verification is in the running app via the
Tauri bridge (unit tests cover the sidecar tool + the Rust classifier). No result
flows back to the parent yet (Phase 2), the child is useful to the human watching
it.

### 1. The spawn trigger (constrained by what the sidecar can push)

Two constraints from the code decide this (both verified against the tree):

- An extension tool **cannot** write a custom frame to stdout during
  `runRpcMode`; Pi owns stdio and a raw `process.stdout.write` corrupts the RPC
  framing. The only sanctioned sidecar to Rust push is `ctx.ui.*`, whose methods
  are a fixed set: `select`/`confirm`/`input`/`editor` (blocking, emit
  `extension_ui_request`, await `extension_ui_response`) and
  `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` (fire-and-forget).
  There is no public method for an arbitrary custom-named frame.
- The tool result's structured `details` does **not** reach the renderer;
  `tool_execution_end` flattens the result to an `output` string via
  `tool_output(result)` (`sidecar.rs`). So the spawn payload cannot ride the tool
  result either.

So the trigger uses the two sanctioned mechanisms for their natural purposes:

1. The parent's `agent` tool `execute()` takes consent with
   `ctx.ui.select("Spawn <type> subagent to: <task>?", [Allow, Allow for this
   session, Deny])` (a clean, human-readable consent card on the parent thread;
   cached per session in the tool). Deny returns a declined tool result.
2. On Allow it mints an `agentId`, then fires a fire-and-forget
   `ctx.ui.notify(SPAWN_SENTINEL + JSON.stringify({ agentId, subagentType,
   task }))`, and returns immediately with a short text result naming the
   spawned agent (fire-and-forget: no wait for the child).
3. In Rust, `classify_extension_ui`'s `notify` branch detects the
   `SPAWN_SENTINEL` prefix and, instead of forwarding a `Notify`, parses the JSON
   and emits a new `AgentEvent::SubagentSpawned { agentId, subagentType, task }`
   on the parent's sink. The notify is fully consumed by Rust and never rendered.
   No manager handle in the reader thread, no new Rust spawn path here.

Double consent is avoided by giving `decide()` (`hoy-permissions.ts:32-41`) an
`agent` branch that returns `allow` (and `block` in plan mode for Phase 1), so the
generic `tool_call` gate does not prompt on top of the tool's own richer consent.

### 2. Child session as a first-class thread (renderer-orchestrated)

`AgentEvent` is **not** session-tagged; the renderer routes events per thread over
a `Channel` it creates and hands to `send_prompt` (verified: the `AgentEvent`
union has no `session_id`; `events.rs:147`'s `session_id` is on `PiState`, not on
events). So a child is cleanest as a real thread with its own id, its own sidecar,
and its own channel, driven through the machinery we already have.

On the `subagentSpawned` event the renderer:

1. Creates a child `Thread` kept **flat** in `project.threads` with a
   `parentThreadId` link (so the one-level `findThread`/`patchThread` traversals
   in `store.ts` stay unchanged; the sidebar derives nesting from the link).
2. Calls `create_session(cwd, childSessionFile, subagentType, parentMode)`, which
   spawns a child sidecar via the existing `spawn_session_in`/`spawn` path with a
   new `HOY_SUBAGENT_TYPE` env (and the parent's permission mode for Phase 1).
3. Calls `send_prompt(childSessionId, task, childChannel)` with a fresh channel
   registered under the child `threadId`. The child streams into
   `turns[childThreadId]` exactly like a user thread.

Renderer `Thread` gains two fields (`lib/types.ts` + `workspace.rs` `WsThread`
mirror + both persistence allowlists, `persistProjects` and `WsThread`):

- `parentThreadId?: string | null` — set on a spawned child, null on user threads.
- `spawnedBy?: { type: string; agentId: string } | null` — the agent type that
  produced it and the parent's handle.

The sidebar renders top-level threads and, beneath each, its children (threads
whose `parentThreadId` matches) nested and collapsed (the two brainstorming
picks). A child persists to `workspace.json` and survives restart; it has a
`sessionFile` once `create_session` runs, so the untouched-thread pruning
(`isUntouched`) never drops it. Reopening a child after restart spawns a sidecar
that opens its JSONL, identical to reopening a user thread.

From the human side the child is an ordinary thread: open it, read the live
transcript. Because it is a real sidecar-driven session, the plumbing to steer it
(Phase 2) and to surface it in a panel (Phase 4) is already present.

### 3. What the child runs in Phase 1 (two hardcoded built-ins)

The `.hoy/agents/*.md` registry is Phase 3. Phase 1 ships two built-in types
defined in code, which also proves per-type tool isolation before the registry
generalizes it:

- **`general-purpose`**: inherits the parent's model and the standard Hoy system
  prompt; tool set is the full `HOY_TOOLS` minus `agent` (depth cap, see Safety).
- **`Explore`**: read-only; tools `read`/`grep`/`find`/`ls` only, no
  `bash`/`edit`/`write`/`agent`; a short read-only exploration prompt.

The `agent` tool accepts `subagentType`; only these two resolve in Phase 1, an
unknown type is an error. The child entry (`hoy-sidecar.ts`) reads
`HOY_SUBAGENT_TYPE` and selects the built-in's tools + prompt when building its
session, reusing the existing `resourceLoaderOptions.systemPromptOverride` seam.

### 4. Safety in Phase 1

- The child's own `bash`/`edit`/`write` calls flow through its own sidecar's
  `hoy-permissions` gate exactly like a user thread, so nothing runs unprompted in
  the child.
- The new risk is "an agent can start another agent loop." The `agent` tool is
  gated: on first use in a session it requires explicit consent
  (Allow / Allow-for-session / Deny) via a new `agent` branch in `decide()`
  (`hoy-permissions.ts:32-41`), instead of falling through to the generic ask or
  plan-block path.
- Depth is hard-capped at 1 in Phase 1: `agent` is withheld from every child's
  tool set, so a child cannot spawn. There is no recursion surface before the
  depth/fanout guards land in Phase 3.
- Rich per-type consent and `project_trust` gating of project-scope agent defs are
  Phase 3 (there are no project-scope defs in Phase 1, only the two code
  built-ins, so the untrusted-repo sharp edge does not exist yet).

### 5. Explicitly out of Phase 1

Result delivery to the parent; `get_agent_result` / `steer_agent`; the
concurrency limiter; the `.hoy/agents/*.md` registry + frontmatter isolation;
`project_trust` gating; the FleetView panel; git worktree isolation. Fire-and-
forget in Phase 1 means the parent gets only a handle; a human watches the child.

### 6. File-level checklist (for writing-plans to expand)

Sidecar (TypeScript):
1. `hoy-agents.ts`: exported `SUBAGENT_TYPES` built-in table (`general-purpose`:
   parent model + `HOY_TOOLS` minus `agent`; `Explore`: `read`/`grep`/`find`/`ls`,
   read-only prompt) and `createHoyAgents()` registering the `agent` tool. Its
   `execute()` validates `subagentType`, takes `ctx.ui.select` consent (cached per
   session), then fires `ctx.ui.notify(SPAWN_SENTINEL + JSON)` and returns.
2. `hoy-sidecar.ts`: wire `createHoyAgents` into `extensionFactories`; add `agent`
   to `HOY_TOOLS`; read `HOY_SUBAGENT_TYPE` and, when set, apply that built-in's
   tools + `systemPromptOverride` for the child entry.
3. `hoy-permissions.ts`: `agent` branch in `decide()` (`allow`, `block` in plan).
4. Unit tests (`hoy-agents.test.ts`) mirroring `hoy-mcp.test.ts`: built-in type
   resolution, unknown type errors, `general-purpose` withholds `agent` (depth
   cap), consent Allow/Deny/Allow-for-session, the notify payload shape.

Rust:
5. `sidecar.rs`: `classify_extension_ui` detects `SPAWN_SENTINEL` on a `notify`
   and returns a new `ExtUiOutcome` that `route_message` maps to
   `AgentEvent::SubagentSpawned`; unit-test the classifier.
6. `events.rs`: `AgentEvent::SubagentSpawned { agent_id, subagent_type, task }`
   (mirror in `types.ts`).
7. `commands.rs` + `sidecar.rs`: `create_session` gains `subagent_type` +
   `permission_mode`; `spawn`/`spawn_session_in` set `HOY_SUBAGENT_TYPE`.
8. `workspace.rs`: `WsThread` gains `parent_thread_id` + `spawned_by`
   (`#[serde(default)]`, camelCase); camelCase round-trip test.

Renderer:
9. `lib/types.ts`: `parentThreadId` + `spawnedBy` on `Thread`; `subagentSpawned`
   in the `AgentEvent` union.
10. `state/store.ts`: on `subagentSpawned`, `spawnChildThread(parentThreadId,
    payload)` creating the flat child thread + `create_session` + `send_prompt`
    with a child channel; add the two fields to the `persistProjects` allowlist.
11. `Sidebar.tsx`: group children under their parent (by `parentThreadId`), nested
    + collapsed with an indent/chevron; include children in the archived filter +
    search projections.

Verification:
12. `packages/sidecar/build.sh` rebuild; unit tests (sidecar + cargo) green;
    live-verify in the running app via the Tauri bridge: prompt the parent to
    spawn an `Explore` subagent, approve the consent, watch the child thread
    appear nested, run to completion in its own transcript, and survive restart.
    Commit `HOY-231:` with evidence.
