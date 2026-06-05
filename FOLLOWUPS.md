# Follow-ups

Deferred engineering work discovered during the build. Not part of any milestone's
acceptance criteria; track and action separately.

## Disk extension / skill discovery from the branded agent dir

Status: open
Depends on: the SDK-sidecar pivot (`docs/plans/sdk-sidecar-pivot.md`) landing first
Introduced: SDK-sidecar pivot

### Context
Once Hoy spawns our own SDK entry, `DefaultResourceLoader` can auto-discover extensions/skills
from `~/.hoy/agent` (`extensions/`, `skills/`, `npm/node_modules`). But loading disk `.ts`
extensions needs `jiti` (runtime TS evaluator) and `typebox` (schema runtime) resolvable at
runtime. Our sidecar is `bun build --compile`d, so they must be bundled or kept as
externally-resolvable dynamic-require targets. zosma-cowork hit exactly this (their #151/#152):
their production bundle shipped without jiti/typebox, so disk extensions silently failed to load.

We deferred this because the branded dir starts empty (fully isolated, no `~/.pi` import), so
there is nothing to load yet — extensions are not a day-one need.

### What's needed
- Confirm `bun build --compile` of `hoy-sidecar.ts` either inlines `jiti`+`typebox` or preserves
  them as runtime-resolvable modules. Add a test that loads a trivial disk extension end to end.
- Decide install UX (how an extension lands in `~/.hoy/agent` — `pi install` flow vs a Hoy UI).
- Until then, the loader runs with extensions effectively off; do not claim extension support.

## In-process custom tools

Status: open
Depends on: the SDK-sidecar pivot (`docs/plans/sdk-sidecar-pivot.md`)
Introduced: SDK-sidecar pivot

### Context
Owning the sidecar entry means we can register custom tools as plain JS in the same process via
`createAgentSession`'s `customTools` / the resource loader's `extensionFactories`, with no RPC
marshaling (this is how zosma ships their office-docs tools). Useful for Hoy-specific
capabilities later. Not part of the pivot itself.

### What's needed
- A small registration point in `hoy-sidecar.ts` (`customTools: [...]` or inline
  `extensionFactories`) and a first concrete tool to justify the surface.
- Decide whether such tools are bundled (always on) or gated behind settings.

## Per-thread model selection (selector targets the control session)

Status: open
Introduced: pre-M3 (M2 wiring), surfaced by the M3 code review

### Context
Spec §2 says the model selector lives in each thread's composer with per-thread scope.
In practice `App.handleSelectModel` calls `set_model(activeSessionId, ...)` against the boot
control session `s1`, not the focused thread's session. It works today only because Pi persists
`defaultModel` to the shared `settings.json` and each newly spawned thread sidecar reads it, so
*new* threads inherit the choice. But: a thread whose sidecar already spawned does not update when
the model changes, and the per-thread selector implies a control it does not have. Not introduced
by the M3 diff (App.tsx unchanged), so left as-is here.

### What's needed
- Route `set_model` to the thread's own `sessionId` (lazily spawning the session if it has none
  yet, or deferring the choice until first prompt), and track the selected model per thread rather
  than from the single control-session `state.model`.

## Reasoning / thinking deltas in the transcript

Status: open
Introduced: M3

### Context
M3's `AgentEvent` union (spec §6) has no reasoning kind, so `map_pi_event` drops Pi's
`thinking_start`/`thinking_delta`/`thinking_end` (the `assistantMessageEvent` thinking variants).
Reasoning-capable models stream their thinking, but the UI shows nothing for it during a turn
even though `ThreadView` already vendors the AI Elements `Reasoning` block (`Turn.reasoning` is
defined but never populated live). Functionally fine for M3 acceptance; a visible gap for
thinking models.

### What's needed
- Add a `reasoning` event kind to `AgentEvent` (events.rs + types.ts together), map the thinking
  deltas to it in `map_pi_event`, accumulate it into `Turn.reasoning` in `lib/turns.ts`, and
  render it through the existing `Reasoning` block. Gate the open/closed default sensibly.

## OAuth identity edge (Claude Pro/Max system prompt validation)

Status: open
Depends on: the SDK-sidecar pivot (`systemPromptOverride`)
Introduced: SDK-sidecar pivot

### Context
The pivot rebrands identity via `DefaultResourceLoader.systemPromptOverride` ("you are Hoy").
But for Claude Pro/Max OAuth, Anthropic's subscription endpoint validates that `system[0]` is the
canonical `"You are Claude Code, Anthropic's official CLI for Claude."` string. `systemPromptOverride`
affects the *discovered* system prompt (system[1]+), not `system[0]` — but we must not break that
transport string for OAuth users. zosma's mitigation: keep `system[0]` intact and add an identity
note in `system[1]` ("user-facing identity is Hoy regardless of what the transport layer says").

### What's needed
- Before relying on a full rebrand, verify against pinned Pi 0.78.0 that an OAuth (Claude Pro/Max,
  also OpenAI Codex) request still succeeds with our override in place.
- Use an identity-note paragraph rather than replacing `system[0]`; add a test/manual check with a
  real OAuth provider.






------------------------------------------------
- Multi-turn sessions persisted → 🔜 M4 (we run SessionManager.inMemory() for now; persistence to ~/.hoy/agent later).

- OAuth (Claude Pro/Max, Copilot) → 🔜 now possible (the SDK exposes login; the binary didn't), but not built, and gated by the identity-edge follow-up.

- Provider switcher → ◐ partial — per-thread model selector + Settings exist; multi-provider works via auth.json.
