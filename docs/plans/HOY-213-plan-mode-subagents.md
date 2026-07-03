# HOY-213: Subagent-driven plan mode + dedicated Plan architect

**Goal:** Make plan mode leverage subagents: allow the plan-mode thread to fan
out read-only exploration, add a dedicated built-in "Plan" architect subagent
that returns a decision-complete plan, and give the produced plan a clean
handoff into execution.

**Status:** Slice 1 gate change landed (agent allowed in plan mode). Prompt
update, Plan subagent, and handoff pending.

## Background: what exists today

- Plan mode is one of four per-thread permission modes. It is inline: a per-turn
  system-prompt suffix (`PLAN_MODE_PROMPT`, revised in HOY-212) turns the main
  thread into a solo architect that explores read-only and writes a plan (inline
  or to `docs/plans/`). Gate: `decide()` in `hoy-permissions.ts`.
- Until this ticket, plan mode blocked the `agent` tool, so it could not spawn
  subagents at all.
- Built-in subagents live in `BUILTIN_SUBAGENTS` (`hoy-agents-registry.ts`):
  `general-purpose` (all tools, inherits base prompt) and `Explore` (read-only:
  read/grep/find/ls, own prompt). A child inherits the parent's permission mode
  at spawn (`store.ts` createSession call).
- Subagents return free text only; there is no structured-output/schema
  mechanism. `extractResultText` (`state/delivery.ts`) reads the child's last
  assistant turn and `buildDelivery` injects it into the parent thread.
- `set_permission_mode` (renderer `store.ts` -> Rust `commands.rs` -> `/hoy_mode`
  -> `hoy-permissions.ts`) is the single choke point for mode changes; the
  renderer `setPermissionMode` action knows both the previous and next mode.

## Reference synthesis

Three sources, distilled:

- **Claude Code**: built-in subagents are Explore / Plan / general-purpose. The
  Plan subagent is read-only (Write and Edit denied), inherits the main model,
  and does codebase research during plan mode so exploration stays in a separate
  context window. There is no ExitPlanMode tool; approval is a mode transition
  and the plan stays in the conversation. The user picks which execute mode to
  approve into.
- **pi-extensions `pi-plan-mode`** (same Pi engine we embed): the architect
  emits its plan inside a machine-detectable `<proposed_plan>...</proposed_plan>`
  wrapper. On detection the extension offers Implement / Keep planning / Discard;
  Implement restores tools and injects a fresh turn: "Plan mode is now disabled.
  Full tool access is restored. Implement this proposed plan now:\n\n${plan}".
  A three-phase architect spine: ground in the codebase, chat to nail intent,
  chat to nail the implementation, then finalize one decision-complete plan.
- **pi-subagents `planner`** and **superpowers `writing-plans`**: planner is
  read-only (read/grep/find/ls, no bash) and must "produce executable, verifiable
  plans, ground them in the repository's actual structure, and call out
  assumptions, risks, sequencing, and verification commands." writing-plans adds:
  no placeholders; every step is the smallest independently testable unit and
  ends with a runnable verification command; name exact file paths.

House style: the sources are full of em-dashes and emojis. All adapted text is
ASCII, no emojis, no em-dashes.

## Slice 1: enable subagents in plan mode + tighten the file gate

Three parts.

1. **agent gate (DONE):** `decide()` allows `agent` in plan mode. Children
   inherit plan mode, so any spawned Explore/Plan child stays non-mutating by
   construction. Test added to the gate table plus the HOY-231 agent-gating
   block updated. Verify: `bun test hoy-permissions.test.ts` (30 pass).

2. **Plan-file gate (path-scoped):** today plan mode allows `write` to ANY path
   (the gate sees only the tool name; the `docs/plans/` scope is a soft
   prompt-only rule) and blocks `edit` entirely. Change to match intent: thread
   the tool input path into `decide()`. In plan mode `write` and `edit` are
   allowed outright when the path resolves under `<project>/.hoy/plans/`, and
   elsewhere they `ask` for approval rather than hard-block. The ask path is
   deliberate: if the user asks for the plan saved somewhere else (or the
   instructions specify a location), the model writes there and the user approves
   the card; the default `.hoy/plans/` location stays prompt-free. Location is
   `.hoy/plans/` (consistent with `.hoy/agents`, `.hoy/mcp.json`), keeping agent
   working plans out of the team's committed `docs/plans/` docs. Path resolution
   rejects traversal outside the plan dir (`isPlanFilePath`).

3. **Prompt:** update `PLAN_MODE_PROMPT` so the inline architect delegates
   parallel read-only exploration to Explore subagents and deep planning to the
   Plan subagent, writes plan files (when it writes one) to `.hoy/plans/` rather
   than `docs/plans/`, and emits its final plan inside a `<proposed_plan>` block
   (the handoff detection token). Keep it concise; do not bloat the HOY-212 body.

**Verify:** sidecar tests green (new path-gate cases: write/edit under
`.hoy/plans/` allowed, elsewhere blocked); live-verify a plan-mode turn spawns an
Explore subagent and the reply ends with a `<proposed_plan>` block.

## Slice 2: dedicated Plan architect subagent

Add a third built-in to `BUILTIN_SUBAGENTS`, making the lineup match Claude Code
(Explore / Plan / general-purpose):

```
{ name: "Plan", scope: "builtin", tools: ["read","grep","find","ls"],
  promptMode: "replace", body: PLAN_SUBAGENT_PROMPT, enabled: true,
  description: "Read-only architect. Delegate deep codebase research and
    produce a decision-complete implementation plan." }
```

- **Tools:** read/grep/find/ls only. No bash, no write, no edit (matches Claude
  Code's Plan subagent and pi-subagents planner). Read-only by construction, so
  it is safe and prompt-free from any mode.
- **Model:** inherit the parent's model (Claude Code inherits; simpler, no pin).
- **Prompt (`PLAN_SUBAGENT_PROMPT`):** architect persona, three-phase spine
  (ground -> design -> produce), read-only, cite paths with line numbers, no
  placeholders, and the `<proposed_plan>` output contract below.
- Auto-advertised to the main agent via `agentToolsPrompt` (dynamic from enabled
  registry types) and surfaced in the Subagents settings panel (registry mirror
  `SubagentDef`), no extra renderer wiring needed.

**`<proposed_plan>` output contract** (shared by inline plan mode and the Plan
subagent so the handoff can detect either):

```
<proposed_plan>
# <title>
## Summary
## Key changes        (grouped by file, each with a path)
## Steps              (numbered, ordered; each names exact paths and ends with a
                       runnable "verify: <cmd>")
## Test plan
## Assumptions and risks
## Critical files     (3 to 5 paths)
</proposed_plan>
```

**Verify:** one-shot registry dump lists "Plan"; sidecar tests; live-verify the
main agent can spawn a Plan subagent whose delivered result contains a
`<proposed_plan>` block; Subagents settings shows the new type with a
disable/enable toggle.

## Slice 3: plan-to-execution handoff

The plan already lives in the thread context (plan and execution share one
thread), matching Claude Code, so the handoff is a nudge, not a context
transplant. Two design questions:

1. **Trigger** (the one real UX fork, see below).
2. **Extraction:** pull the last `<proposed_plan>` block from the thread's recent
   turns (assistant text or a delivered subagent result). Reuse the delivery
   inject pattern (`store.ts` deliverToParent) to add a synthetic execution
   kickoff turn: "The plan above is approved. Implement it now, following the
   steps in order." plus the extracted plan. If the plan was written to a
   `docs/plans/*.md` file instead, point the executor at that path.

Add a per-thread `pendingPlan` marker (or derive on demand from the transcript)
so the UI can show a plan-ready affordance.

### Handoff trigger: pi-plan-mode select card (DECIDED)

Chosen: on turn-end, when mode is plan and the assistant's last message contains
a `<proposed_plan>` block, the sidecar raises a select card "Plan ready. What
next?" with Implement this plan / Keep planning / Discard. This mirrors
pi-plan-mode and gives an explicit approve-and-execute gesture distinct from just
changing the mode dropdown.

Integration with our RPC architecture (the plumbing that makes this fit):

- **The card reuses the existing extension-UI protocol.** `ctx.ui.select` in the
  sidecar already emits `extension_ui_request` that the renderer renders and
  answers via `respond_permission` (this is how permission approval cards work
  today, HOY-186). So the three-option card renders through existing plumbing.
- **Detection:** an `agent_end` (turn-end) handler in the sidecar permission
  extension, active only while mode is plan, scans the final assistant message
  for the last `<proposed_plan>...</proposed_plan>` block.
- **Card options (execute mode chosen at approve time):** the card offers
  "Implement (review each edit)" / "Implement (auto-approve edits)" / "Keep
  planning" / "Discard". The two Implement options pick the execute mode the
  handoff lands in (default vs acceptEdits), mirroring Claude Code's approval
  menu, so the user chooses oversight level at approval, not before.
- **On Implement:** the handoff must (a) flip the thread to the chosen execute
  mode and (b) start a turn implementing the plan. Turn lifecycle in our app is
  renderer-driven, so rather than have the extension inject the turn directly,
  the sidecar emits a sentinel notify (same mechanism as
  `@hoy/spawn-subagent:`, e.g. `@hoy/plan-ready:{...}` carrying the plan text and
  the chosen mode) that Rust turns into an event; the renderer then switches mode
  (existing `setPermissionMode`) and sends the kickoff prompt (existing
  `send_prompt`): "Plan mode is now disabled. Full tool access is restored.
  Implement this proposed plan now:\n\n${plan}". This keeps turn-driving in the
  renderer where it belongs. If the plan was written to a `.hoy/plans/*.md` file,
  point the executor at that path as well.
- **On Keep planning:** no-op; stay in plan mode.
- **On Discard:** no injection; the plan block can be left in history (a later
  `context` filter to strip stale plans is optional, out of scope here).

**Resolved: renderer-side detection (not sidecar `ctx.ui.select`).** The pi API
does expose `agent_end` (with `messages[]`) and `turn_end`, but raising
`ctx.ui.select` inside `agent_end` in RPC mode would block the turn-completion
path the renderer waits on (the terminal `done`), risking a wedged turn. Since
the produced plan already lands in the thread transcript (inline plan mode's
assistant turn, or a delivered Plan-subagent result), the renderer can detect and
present the card without any sidecar/Rust change. This delivers the same
Implement / Keep planning / Discard card UX with less risk and fewer moving
parts, so Slice 3 is renderer-only:

- **Extraction:** `extractProposedPlan(text)` via
  `/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i` over the just-completed
  assistant turn (and delivered subagent results).
- **Trigger:** when a plan-mode thread's turn completes, if a plan block is
  present, set a transient store marker `planReady[threadId] = plan` (a store
  map like `streaming`/`threadErrors`, not persisted).
- **Card:** ThreadView renders a "Plan ready" card above the composer with
  Implement (review each edit) / Implement (auto-approve edits) / Keep planning /
  Discard.
- **Actions:** Implement(mode) calls `setPermissionMode(threadId, mode)` then
  sends the kickoff prompt ("Plan mode is now disabled. Full tool access is
  restored. Implement this proposed plan now:\n\n${plan}") and clears the marker;
  Keep planning / Discard just clear the marker.

## Verification and rollout

Per slice: full `check` gate (tsc, cargo check, clippy, fmt) + `bun test` in both
`apps/desktop` and `packages/sidecar/pi-src`, then live-verify in the running app
(screenshot the plan-ready flow), then a focused local commit (no push). Close
HOY-213 with evidence once all three slices land.

## Out of scope (YAGNI)

- Structured JSON/schema plan output (no engine support; the `<proposed_plan>`
  markdown contract is the structure).
- A `plan_mode_question` structured-question tool (nice-to-have; defer).
- Full subagent-driven-development execution (fresh implementer per task, file
  handoffs, progress ledger). This ticket plans; it does not rebuild execution.
- Pinning a specific planning model.
