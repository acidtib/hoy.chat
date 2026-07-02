# HOY-213: subagent-driven plan mode (and the subagent infrastructure it needs)

Spike. Ticket asks: once Hoy has subagent support, rework plan mode to use a
dedicated **plan subagent** (like Claude Code's `Plan` agent type) with its own
isolated system prompt, tool allowlist, and model, plus a structured
plan-to-execution handoff.

The ticket says so itself: *"Blocked on: subagent infrastructure existing in Hoy
(no ticket yet)."* So this is really two layers, and HOY-213 is the second:

1. **Subagent infrastructure** (the unblocker, currently ticketless). Give Hoy a
   generic "spawn a specialized child agent" capability: a proxy `agent` tool, a
   registry of agent types defined by markdown+frontmatter, isolated
   prompt/tools/model per type, and a result contract back to the parent.
2. **HOY-213 proper** — the *first consumer* of that infrastructure: a `Plan`
   agent type, plus the plan-mode UX and the plan→execution handoff.

The reference URLs (`tintinweb/pi-subagents`, `nicobailon/pi-subagents`,
`baphuongna/pi-crew`, `gotgenes/pi-packages` subagents + worktrees,
`pi.dev/packages/pi-subagents`) are all implementations of layer 1. We learn from
them and build our own, exactly as we decided for MCP (HOY-210). Nothing here is
buildable until layer 1 lands.

## Verdict

**Build subagent infrastructure as our own in-process Pi capability in the
sidecar, using the SDK's `createAgentSession` for nested child sessions, exposed
as a single branded proxy `agent` tool driven by `.hoy/agents/*.md` definitions.
Then implement HOY-213 as a `Plan` agent type on top of it, keeping the existing
inline plan-mode toggle for the cheap case (Claude-Code-style dual model).**

Recommend splitting into two tickets:

- **HOY-NNN (new): "Subagent infrastructure."** The `createHoyAgents(...)`
  extension, the `agent` tool, agent-type discovery + isolation, result contract,
  concurrency, consent, worktree isolation as a follow-on. This is the real work.
- **HOY-213 (this): "Plan subagent."** Depends on HOY-NNN. Ship a `Plan` type,
  move `PLAN_MODE_PROMPT` into its own replace-mode prompt, wire the handoff.

## Pi 0.80.3 ships NO native subagent primitive (evidence)

- Grepping installed `dist`
  (`packages/sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent`, pinned
  0.80.3) for `subagent|sub_agent|subAgent|orchestrat|subsession|dispatch` returns
  nothing (the one `dispatch` hit is `configureHttpDispatcher`).
- Core tool set is exactly seven built-ins, no `agent`/`task`:
  `read | bash | edit | write | grep | find | ls` (`dist/core/tools/index.d.ts:21`).
- The RPC `RpcCommand` union (`dist/modes/rpc/rpc-types.d.ts:14-130`) has no
  subagent/task command. `new_session`/`fork`/`clone`/`switch_session` are
  single-session lifecycle ops that *replace* the one session the process owns.
  A `runRpcMode` process is strictly one live `AgentSession`.
- `ExtensionAPI` (`dist/core/extensions/types.d.ts:822-978`) exposes
  `registerTool`, `registerCommand`, events, `sendMessage`, `setModel`,
  `getActiveTools`/`setActiveTools` — but **no method that spawns a nested agent
  or registers an agent type.** The session-replacement ops (`newSession`, `fork`,
  `switchSession`) live on `ExtensionCommandContext` (command handlers only,
  `types.d.ts:246-283`), not on the `ExtensionContext` a tool's `execute()`
  receives.

So "subagents in Pi" is always a third-party pattern layered on the SDK, not a Pi
feature. Every reference below hand-rolls it. Hoy's subagent support IS "build the
capability," same conclusion as HOY-210 for MCP.

## The community landscape: two spawn models

There are four+ competing, incompatible `pi-subagents` packages and no official
spec. They split cleanly into two mechanisms, and picking between them is the
central architectural decision for layer 1.

| Package | Spawn model | Tool surface | Notes |
|---|---|---|---|
| **`tintinweb/pi-subagents`** (~553★) | **In-process** nested `createAgentSession` | `Agent` + `get_subagent_result` + `steer_subagent`; `subagent_type` param | Claude-Code look/feel; heavy `pi-tui` UI; worktree isolation; scheduling |
| **`gotgenes/pi-subagents`** | **In-process** nested `createAgentSession` | single `subagent` tool + result/steer | Friendly fork of tintinweb; minimal core + companion pkgs (permissions, worktrees); **cleanest architecture** |
| **`nicobailon/pi-subagents`** (pi.dev registry) | **Child `pi --mode json -p` CLI processes** | single `subagent` mega-tool, mode discriminator (single/chain/parallel/fanout) + `wait` | Most mature/engineered; structured output via JSON Schema; `pi-intercom` supervisor bridge |
| **`baphuongna/pi-crew`** | **Child `pi --mode json -p` CLI processes** | single `team` tool, `action` enum | Crew workflows, durable on-disk state; largely AI-authored, heavy, has an unsandboxed dynamic-workflow security hole; mine patterns, do not vendor |

**Mechanism A: in-process nested sessions** (tintinweb, gotgenes). Inside a custom
tool's `execute()`, construct a `SessionManager.inMemory()` + `createAgentSession({
tools, model, resourceLoaderOptions: { systemPromptOverride } })`, drive it with
`session.prompt()`, harvest `getLastAssistantText()`, `dispose()`. Pi exports all
the building blocks (`dist/core/sdk.d.ts`, `dist/core/agent-session.d.ts`) but
gives zero wrappers, no agent-type registry, and no plumbing of the child into the
parent's RPC event stream. You build all of that.

**Mechanism B: child CLI processes** (nicobailon, pi-crew). Spawn full `pi --mode
json -p "<task>"` children with `--system-prompt` / `--tools` / `--model` /
`--no-session` flags, parse their stdout JSONL, take the final text. This is
fire-and-collect **print mode, not `runRpcMode`**, and it spawns the **stock `pi`
CLI**, which we do not ship (we ship our branded sidecar).

### Our decision: Mechanism A (in-process nested sessions in the sidecar)

Recommend Mechanism A, matching the two cleanest references (gotgenes' minimal
core is the model to study), for these reasons:

- **It does not violate "Pi runs as a separate spawned process."** That
  non-negotiable is about never embedding Pi into the Rust core or the renderer,
  and never reimplementing Pi's agent loop. The **sidecar already is a full Pi
  runtime process**; nested `createAgentSession` calls inside it use Pi's own SDK
  and reimplement nothing. Multiple agent loops in the one sidecar process is not
  "embedding Pi in-process" in the sense CLAUDE.md forbids. State this explicitly
  to preempt re-litigation.
- **Mechanism B would spawn the stock `pi` CLI**, the exact thing our sidecar
  exists to replace (branding, `auth.json`, `systemPromptOverride`, branded dirs).
  Using it means either shelling out to a CLI we don't ship, or re-invoking our
  own sidecar binary per child and rebuilding all the flag plumbing. Heavier and
  off-architecture.
- **Result return is clean in-process.** The `agent` tool's `execute()` awaits the
  child and returns its output as the tool result directly; no cross-process
  round-trip back through Rust mid-tool-call.

**The one real tension** (call it out, don't bury it): CLAUDE.md commits us to
sidecar state **keyed by `sessionId` from day one** precisely to keep the
multi-session orchestration endgame open (a FleetView-style panel of concurrent
agents). Mechanism A runs child sessions *inside* one sidecar process, so v1
subagents are not first-class Rust-orchestrated sessions surfaced as their own UI
threads. That is fine for v1 and does not block the endgame: emit child
`AgentEvent`s tagged with a child `sessionId` (parent id + suffix) over the
existing channel so the renderer can render subagent activity, and leave the door
open to later promoting heavy/long-lived subagents to their own Rust-spawned
sidecar sessions. Design the event tagging and the `sessionId` scheme in v1;
defer the separate-process promotion.

## Where subagents live, and the API we build against

In-process extension factory, same shape as `createHoyPermissions` /
`createHoyMcp` (HOY-210):

```ts
// hoy-sidecar.ts
extensionFactories: [
  createHoyPermissions(initialMode),
  createHoyMcp(mcpConfig),        // HOY-210
  createHoyAgents(agentsConfig),  // HOY-NNN (this work)
],
```

`createHoyAgents` returns `function hoyAgents(pi: ExtensionAPI) { ... }` and uses
the verified 0.80.3 surface:

- `pi.registerTool(...)` — the single proxy `agent` tool (+ optional
  `get_agent_result` / `steer_agent` for background runs).
- Inside `execute(toolCallId, params, signal, onUpdate, ctx)`: resolve the
  `subagent_type` to a definition, build a child session via the SDK
  (`createAgentSession` or `createAgentSessionServices` +
  `createAgentSessionFromServices`) with:
  - `tools` / `excludeTools` / `noTools` — the type's allowlist
    (`agent-session-services.d.ts:44-58`, `sdk.d.ts:36-48`).
  - `model` / `thinkingLevel` — per-type model selection.
  - `resourceLoaderOptions.systemPromptOverride` — the type's isolated prompt.
    **Note:** the override lives on the *resource loader*, not on the session
    options (confirmed: there is no `systemPromptOverride` field on
    `CreateAgentSessionFromServicesOptions`; our sidecar already wires it via
    `resourceLoaderOptions` at `hoy-sidecar.ts:58-60`).
  - Drive with `session.prompt(task)`; stream progress via `onUpdate`; harvest
    `getLastAssistantText()` / structured output; `dispose()`.
- `pi.on("session_shutdown", ...)` — tear down any live child sessions.

## Config location and branding (fully ours)

- **Agent-type defs:** markdown + YAML frontmatter, body = system prompt. Discover
  project-then-global, project wins:
  - Project: `<project>/.hoy/agents/<name>.md` (rebrand the references'
    hardcoded `.pi/agents/`).
  - Global: `~/.hoy/agent/agents/<name>.md` (dev `~/.hoyd/agent/agents/`). Pi's
    `getAgentDir()` honors `PI_CODING_AGENT_DIR`, which Rust already exports, so
    the global path is close to drop-in; the **project `.pi/` literal is
    hardcoded in every reference and must be rewritten** (same treatment as
    HOY-222's `.hoy/` config dir).
- **Runtime settings:** `~/.hoy/agent/subagents.json` + `<project>/.hoy/subagents.json`
  (`maxConcurrent`, `graceTurns`, etc.), Rust-owned atomic read/write like
  `pi_config.rs` / `mcp_config.rs`.
- **Frontmatter fields** (union of the references, all optional): `description`,
  `display_name`, `tools` (allowlist from the seven built-ins + `mcp`),
  `model` (full id or fuzzy `"opus"`/`"sonnet"`), `thinking`
  (`off|minimal|low|medium|high|xhigh`), `max_turns`, `prompt_mode`
  (`replace|append`), `inherit_context`, `run_in_background`, `isolation`
  (`worktree`), `enabled`.

## Design ideas worth stealing (not the code)

- **Single proxy `agent` tool with a `subagent_type` param** (Claude-Code /
  gotgenes shape), NOT one tool per type. Tiny model-facing surface (~one tool
  vs 10k+ tokens of per-agent schemas), matches the `Agent` tool the model
  already knows.
- **Markdown+frontmatter agent defs, project-then-global precedence**,
  frontmatter authoritative over caller params (the orchestrator can't pick an
  arbitrary model if the type pins one). gotgenes/nicobailon precedence
  (`builtin < package < user < project`, `false` to unset) is the clean design.
- **Structured result contract, not text-only.** Return
  `{ result, durationMs, tokens{in,out,total}, toolUses }` (gotgenes) and/or a
  child-written `0600` JSON file validated against a schema (nicobailon). This
  maps almost 1:1 onto our `AgentEvent` union and is exactly what HOY-213's
  plan→execution handoff needs.
- **Graceful `max_turns`:** at the limit, `session.steer("wrap up now")`, allow
  `graceTurns` extra, then `abort()`. Statuses `completed|steered|aborted|stopped`.
  Produces clean partial output instead of a hard cut.
- **Background concurrency limiter with queueing** (default 4), foreground
  bypass; `resume`/`steer` on running agents.
- **Depth/recursion guard:** cap nesting (2 levels), gate a child's ability to
  spawn on the literal presence of `agent` in its allowlist (nicobailon's
  `fanoutAuthorized`, gotgenes' depth cap).
- **Read-only agents auto-lose write access to memory** — nice least-privilege
  default and directly relevant to a read-only Plan agent.
- **Git worktree isolation as an opt-in companion** (both families ship it):
  `git worktree add --detach <path> HEAD`; on finish, no changes → remove;
  changes → commit to branch `pi-agent-<id>` (or capture a `.patch`), remove
  worktree, hand the parent the exact `git merge <branch>` command; strict-fail
  if not a git repo / no commits (never run unisolated); prune orphans on
  startup. Plain `git` subprocess calls, cleanly reimplementable in our Rust
  core. Defer to v2 (parallel-editing story); Plan mode is read-only and doesn't
  need it.
- **Dual-channel rendering:** structured `<task-notification>` to the LLM, a
  themed box to the user (tintinweb). Fits our AgentEvent(renderer) vs
  prompt(agent) split.

## Security posture (must be explicit)

- **Spawning a subagent = running an agent loop with tools** (`bash`, `edit`,
  `write`). Treat it like `bash`: our name-based gate (`hoy-permissions.ts`) sees
  only the single tool name `agent`, so per-type/per-tool consent must live
  **inside `createHoyAgents`**, and the child's own tool calls must still flow
  through the permission gate. Add an explicit `agent`/`subagent` branch to
  `decide()` (`hoy-permissions.ts:32-41`) instead of letting it fall into the
  generic `ask` / plan-`block` path.
- **Untrusted repo `.hoy/agents/*.md` is the sharp edge** (same as MCP's
  `.hoy/mcp.json`): cloning a repo must not let it silently define a
  broad-tool agent that then runs. Gate project-scope agent defs behind Pi's
  `project_trust` + explicit consent.
- **Recursion/fanout must be bounded** (depth guard + allowlist gating) so a
  runaway parent can't spawn unbounded children.
- **`--no-verify` / auto-commit surprises:** if we adopt worktree auto-commit
  later, the references commit with `--no-verify` (bypasses local hooks) and run
  `git add -A`; be deliberate about it.

## HOY-213 proper: the plan subagent (layer 2)

Once layer 1 exists, HOY-213 is small. Answering the ticket's seven design
questions concretely:

1. **Dedicated subagent vs inline toggle?** Both, like Claude Code. Keep the
   existing inline plan mode (Shift-Tab-style toggle, `hoy_mode plan`) for quick
   planning in the main thread, and add a `Plan` agent type for deep planning.
   The main agent (or the user) dispatches `agent({ subagent_type: "Plan", ... })`
   for the heavy case.
2. **Plan agent tool allowlist:** read-only — `read, grep, find, ls` + a safe
   bash subset (git log/diff/status, cat, ls). **Explicitly disallow
   `write, edit, agent` (and `mcp` writes).** Note this is *stricter* than today's
   inline plan gate, which currently allows `write` (scoped to `docs/plans/` by
   prompt only) and `bash` wholesale (`hoy-permissions.ts:35-38`). The Plan
   *subagent* should not write plan files itself; it returns structured plan data
   and the handoff persists it.
3. **Own system prompt, not a suffix.** Today `PLAN_MODE_PROMPT`
   (`hoy-system-prompt.ts:91-151`) is *appended* to the main agent's prompt via
   `before_agent_start` (`hoy-permissions.ts:139-147`). For the Plan agent, move
   that content into a standalone `replace`-mode prompt (`.hoy/agents/Plan.md` or
   a bundled default) so the architect persona isn't crowded by the main agent's
   tool guidelines, git rules, and safety rules. Reference the Claude Code plan
   subagent prompt and obra/superpowers `writing-plans` skill as inputs (the
   existing comment at `hoy-system-prompt.ts:88-89` already cites these).
4. **Structured plan output:** `{ goal, architectureSummary, steps:[{ description,
   files:[...] }], criticalFiles:[...] }` via the result contract / `outputSchema`.
   This is the handoff payload.
5. **Model selection:** per-type `model` in frontmatter. Default `inherit`
   (Claude Code's `model: 'inherit'`); optionally allow a stronger planning model
   (the enhanced community Plan uses Opus for planning, Sonnet for execution). Our
   frontmatter `model` field covers this with no extra work.
6. **Plan→execution handoff:** on plan approval (user exits plan mode / accepts),
   inject the structured plan into the *main* session's context so the execution
   agent builds exactly what was planned. Today the plan lives only in the chat
   transcript; the structured result contract from layer 1 is what makes a clean
   handoff possible (plan output → execution context).
7. **`hoy-system-prompt.ts` split:** `PLAN_MODE_PROMPT` becomes two things — a
   short inline-mode suffix (simple planning, unchanged mechanism) and the
   separate `Plan` agent prompt (deep planning). `hoy-permissions.ts` inline gate
   logic stays for the toggle; the subagent dispatch path is new.

## Phasing

1. **HOY-NNN v1 (infrastructure):** `createHoyAgents` in-process extension;
   proxy `agent` tool; `.hoy/agents/*.md` discovery (project + global) with
   frontmatter (`tools`, `model`, `thinking`, `prompt_mode`, `max_turns`);
   isolated child session via `createAgentSession`; structured result contract;
   foreground + background with a concurrency limiter; graceful `max_turns`;
   depth guard; per-type consent through the permission gate; `project_trust`
   gating for project defs; child `AgentEvent`s tagged with a child `sessionId`.
   Ship two built-in types: `general-purpose` and `Explore` (read-only). Rust
   `subagents.json` read/write + `lib/ipc.ts` + `lib/types.ts`; respawn sidecar on
   config change. Live-verify a real subagent round-trips over RPC.
2. **HOY-213 (plan subagent):** add the `Plan` type; move `PLAN_MODE_PROMPT` into
   a `replace`-mode prompt; structured plan schema; plan→execution handoff;
   keep the inline toggle. Live-verify: dispatch a Plan subagent, get a
   structured plan, approve, watch execution use it.
3. **v2:** git worktree isolation for parallel editing agents; chains/parallel
   fanout; promoting long-lived subagents to first-class Rust-spawned sidecar
   sessions surfaced in a FleetView-style panel; scheduling.

## Implementation checklist (for the follow-up tickets)

**HOY-NNN (infrastructure):**
1. `hoy-agents.ts`: `createHoyAgents(config)` — agent-type discovery
   (`.hoy/agents/*.md`, project + global), frontmatter parse (use a real YAML
   parser, not the references' hand-rolled one), child session build via the SDK
   with per-type `tools`/`model`/`thinking`/`systemPromptOverride`, structured
   result contract, foreground/background + concurrency limiter, graceful
   `max_turns`, depth guard, `session_shutdown` teardown. Unit tests like
   `hoy-permissions.test.ts`.
2. Register the `agent` tool; wire `createHoyAgents` into `extensionFactories`
   (`hoy-sidecar.ts:68`); add `agent` to `HOY_TOOLS` (`hoy-sidecar.ts:29`).
3. Add an explicit `agent`/`subagent` branch to `decide()`
   (`hoy-permissions.ts:32-41`); route child tool calls through the gate;
   per-type consent + `project_trust` for project defs.
4. `subagents_config.rs` (or extend an existing config module): atomic read/write
   of global + project `subagents.json`; Tauri commands + `lib/ipc.ts` +
   `lib/types.ts`.
5. Child `AgentEvent` tagging with a child `sessionId`; renderer surface for
   subagent activity (minimal in v1).
6. Respawn sidecar on config change (reuse the auth.json/mcp respawn path in
   `sidecar.rs`).
7. `packages/sidecar/build.sh` rebuild + live-verify a real subagent over RPC.

**HOY-213 (plan subagent), after HOY-NNN:**
8. `.hoy/agents/Plan.md` (or bundled default): read-only tools, architect prompt
   moved out of `PLAN_MODE_PROMPT`, optional planning model.
9. Split `PLAN_MODE_PROMPT` (`hoy-system-prompt.ts:91-151`) into inline suffix +
   Plan agent prompt.
10. Structured plan schema + plan→execution handoff (inject approved plan into the
    main session context).
11. Keep the inline plan toggle; add the subagent dispatch path. Live-verify the
    full plan→approve→execute flow; commit `HOY-213:` with evidence.

## Alternatives considered

- **Mechanism B (spawn child `pi --mode json -p` CLI processes)** — the
  nicobailon / pi-crew approach. Rejected as the primary mechanism: it spawns the
  stock `pi` CLI we deliberately do not ship, duplicating our branding, `auth.json`,
  prompt-override, and branded-dir plumbing per child. Its structured-output and
  worktree recipes are still worth stealing. Keep as a fallback if in-process
  nested sessions prove unstable under Pi's evolving SDK.
- **Rust-orchestrated child sidecar per subagent (each its own `runRpcMode`
  session)** — the "purest" fit for the `sessionId`-keyed multi-session design.
  Rejected for v1 as too heavy: the `agent` tool call would have to round-trip to
  Rust to spawn and stream back mid-tool-call. It is the right shape for the v2
  FleetView endgame; v1's `sessionId` tagging keeps that door open.
- **Vendor a community package as-is** — rejected, same reasoning as HOY-210's
  MCP adapter: third-party code, hardcoded `.pi/` branding, `pi-tui` UI panels we
  can't drive in a webview, and (pi-crew) an admitted unsandboxed
  dynamic-workflow security hole. gotgenes' minimal core is the best *reference*
  to study; tintinweb is the most feature-complete; nicobailon is the most
  engineered orchestration surface. Build our own, keep all three bookmarked.
