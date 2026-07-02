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
streaming transcript, and persists across an app restart. Verified live over raw
RPC and in the running app via the Tauri bridge. No result flows back to the
parent yet (Phase 2), the child is useful to the human watching it.

### 1. The spawn control path (sidecar to Rust)

Today the sidecar to Rust channel is mostly Rust-drives-sidecar, with one
exception that is the exact precedent we need: the extension UI protocol. The
permission extension emits `extension_ui_request` on stdout and blocks until Rust
writes the matching `extension_ui_response` (`hoy-permissions.ts:4-5`,
`sidecar.rs:365`). That is a sidecar to Rust to renderer and back request/response
already in production. `spawn_subagent` follows the same shape.

Flow:

1. The parent's `agent` tool `execute()` emits a control frame on stdout:
   `{ type: "spawn_subagent", id, parentSessionId, subagentType, task }`.
2. `sidecar.rs`'s reader classifies `spawn_subagent` as a control frame (like it
   classifies `extension_ui_request`), NOT a renderer `AgentEvent` to forward
   verbatim. It hands it to the session manager.
3. Rust allocates a child `threadId` + `sessionId`, resolves a fresh child session
   JSONL path under the branded agent dir, and spawns a child sidecar via the
   existing `spawn_session_in` machinery (`sidecar.rs:787`), inheriting the
   parent's `cwd`/project, setting `PI_CODING_AGENT_DIR`, `HOY_SESSION_FILE`
   (child JSONL), `HOY_PERMISSION_MODE` (inherit parent's mode for Phase 1), and a
   new `HOY_SUBAGENT_TYPE` so the child entry selects the right built-in.
4. Rust replies to the parent frame with `{ type: "spawn_subagent_result", id,
   agentId, childSessionId }`. The parent tool `execute()` unblocks and returns
   `{ agentId }` as its tool result (fire-and-forget: it returns a handle, not the
   child's output).
5. Rust immediately sends the `task` to the child sidecar as its first prompt and
   drives it over normal RPC.

The parent tool call is non-blocking in the fire-and-forget sense: it awaits only
the fast `spawn_subagent_result` ack (a handle), not the child's run.

### 2. Child session as a first-class thread

Rust streams the child sidecar's `AgentEvent`s to the renderer tagged with the
child `sessionId`, over the existing Channel. Every `AgentEvent` already carries
`session_id` (`events.rs:147`); the renderer routes child events to the child
thread by that id, exactly as it routes a user thread's events today. No new event
transport.

Renderer `Thread` gains two fields (`lib/types.ts` + `workspace.rs` mirror):

- `parentThreadId?: string | null` — set on a spawned child, null on user threads.
- `spawnedBy?: { type: string; agentId: string } | null` — the agent type that
  produced it and the parent's handle.

The child thread renders nested and collapsed under its parent in the sidebar
(the two picks from brainstorming). It persists to `workspace.json` under the
existing touched/auto-collapse rules: it survives restart, reopens from the same
child JSONL, and stays collapsed so runs do not clutter. Reopening a child thread
after restart spawns a sidecar that opens its JSONL, identical to reopening a user
thread.

From the human side the child is an ordinary thread: open it, read the live
transcript. Because it is a real Rust-driven sidecar session, the plumbing to
steer it (Phase 2) and to surface it in a panel (Phase 4) is already present.

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
1. `hoy-agents.ts`: `createHoyAgents()` registering the `agent` tool; its
   `execute()` emits the `spawn_subagent` control frame and awaits the ack.
   Built-in type table (`general-purpose`, `Explore`) with tools + prompt.
2. `hoy-sidecar.ts`: wire `createHoyAgents` into `extensionFactories`; add `agent`
   to `HOY_TOOLS`; read `HOY_SUBAGENT_TYPE` and apply the built-in's tools +
   `systemPromptOverride` when the entry is a spawned child.
3. `hoy-permissions.ts`: `agent` branch in `decide()` for the spawn consent.
4. Unit tests mirroring `hoy-permissions.test.ts` / `hoy-mcp.test.ts` (control
   frame emitted, ack awaited, built-in type resolution, depth cap withholds
   `agent`, consent paths).

Rust:
5. `sidecar.rs`: classify `spawn_subagent` as a control frame; spawn the child via
   `spawn_session_in` with the inherited env + `HOY_SUBAGENT_TYPE`; reply with
   `spawn_subagent_result`; drive the child and stream its events tagged by child
   `sessionId`.
6. Thread model: `parentThreadId` + `spawnedBy` in `workspace.rs` (+ persistence
   allowlist) and the child-session bookkeeping in the session manager.

Renderer:
7. `lib/types.ts`: `parentThreadId` + `spawnedBy` on `Thread`.
8. `state/store.ts`: create/route the child thread on the first child event;
   nest + collapse under the parent; persist per existing rules.
9. Sidebar: render nested collapsed child rows under a parent.

Verification:
10. `packages/sidecar/build.sh` rebuild; live-verify over RPC (dispatch `agent`,
    watch the child session run) and in the running app via the Tauri bridge
    (child thread appears nested, runs, survives restart). Commit `HOY-231:` with
    evidence.
