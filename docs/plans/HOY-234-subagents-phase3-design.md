# HOY-234: Subagents Phase 3, agent-type registry + safety hardening (design)

Generalizes Phase 1's two hardcoded built-in subagent types (`general-purpose`,
`Explore`) into a user-authorable registry backed by `.hoy/agents/*.md` files,
with a project-trust safety gate, a formalized depth cap, and a settings UI.

Builds on Phases 1-2 (HOY-231 shipped the spawn path and first-class child
threads; HOY-233 shipped result delivery). Phase 3 does NOT change how a child
runs; it replaces the source of a child's tools + prompt (today a hardcoded table
in `hoy-agents.ts`) with definitions loaded from a registry.

Prior art: `docs/plans/HOY-213-subagent-driven-planning-findings.md` (the community
survey of markdown+frontmatter agent defs, precedence, trust, depth). Note that
survey assumed the in-process child-session model; Phases 1-2 shipped the
FleetView-native model instead, so only its config/discovery/frontmatter/safety
guidance applies, not its child-session mechanics.

## Scope

- `.hoy/agents/*.md` discovery: project + global + in-code built-ins, body =
  system prompt, YAML frontmatter = config.
- Frontmatter (MVP): `description`, `tools`, `prompt_mode` applied at runtime;
  `model`, `thinking` parsed and applied via the existing per-session RPC path.
- `project_trust` gating of project-scope agent defs (a cloned repo must not
  silently define a broad-tool agent that then runs).
- Depth guard formalized: a child never receives the `agent` tool, regardless of
  frontmatter (Phase 1 hard-cap made explicit in the registry path).
- Rust `subagents.json` (global + project) enable/disable state, read/written like
  `mcp_config.rs`; a settings UI panel.
- The two built-ins shipped as the registry's base layer.

### Explicitly deferred (own follow-ons)

- Concurrency limiter (cap + queue + foreground bypass) - already its own ticket.
- Graceful `max_turns`, `inherit_context`, `run_in_background`, `isolation:
  worktree` frontmatter fields - parsed-but-ignored or rejected with a diagnostic
  in Phase 3.
- An in-app `.md` editor (Phase 3 lists + enables/disables + opens in the OS
  editor; authoring is by hand).
- A dedicated Hoy project-trust management UI. Phase 3 reuses Pi's existing trust
  store via `ctx.isProjectTrusted()`; surfacing a first-class trust decision in
  Hoy is a cross-cutting gap (it affects MCP too) tracked separately.
- Depth > 1 (children spawning children). Kept hard-capped at 1.

## Architecture: sidecar is the single parser

The sidecar owns registry parsing (built-ins live in its code, and it already
resolves a child's type from `HOY_SUBAGENT_TYPE`). Making it the sole parser gives
one authority for the whole registry (built-ins + files + validation + precedence)
and guarantees the settings UI shows exactly what runtime will use, with no
drift and no `serde_yaml` in Rust. The UI reads the registry through a one-shot
sidecar invocation, mirroring the existing OAuth one-shot (`HOY_OAUTH_LOGIN`,
`hoy-sidecar.ts:51`). Rust owns only `subagents.json` (JSON enable/disable state)
and the spawn+capture of that one-shot, mirroring how it already spawns the
sidecar for OAuth.

```
.hoy/agents/*.md (project)   ~/.hoy/agent/agents/*.md (global)   in-code built-ins
         |                              |                              |
         +---------------+--------------+---------------+--------------+
                                        |
                     sidecar hoy-agents-registry.ts (Pi parseFrontmatter)
                     built-ins + global + project, merged, validated,
                     agent stripped, disabled overlaid from subagents.json
                       |                              |
          runtime: parent advertises +      one-shot HOY_LIST_SUBAGENTS=1
          validates + trust-gates;          prints resolved registry JSON, exits
          child applies tools + prompt              |
                       |                    Rust list_subagents (spawn+capture)
          HOY_SUBAGENT_TYPE (name)                  |
          selects the child's type          renderer caches -> SubagentsPanel (UI)
                                             + spawnChildThread model/thinking

Rust subagents.json (serde_json): enable/disable state only.
  set_subagent_enabled writes it (respawns idle sidecars);
  the sidecar reads it for the disabled overlay.
```

### Registry model (shared file-format contract)

An agent type resolves by layering, later wins on name collision:

1. **built-in** (in code): `general-purpose`, `Explore`. Always present.
2. **global**: `~/.hoy/agent/agents/<name>.md` (`~/.hoyd/agent/agents/` in debug).
3. **project**: `<project>/.hoy/agents/<name>.md`. Trust-gated (see Safety).

`subagents.json` (Rust-owned, global + project, JSON) overlays only enable/disable
state per name (mirroring MCP's `disabled` flag), so toggling an agent in settings
never edits the authored `.md` file.

### Frontmatter schema (MVP)

```yaml
---
description: One-line summary for the UI and prompt advertisement.
tools: [read, grep, find, ls]   # allowlist from the built-in set + mcp; `agent` rejected (depth cap). Omit = default full set minus agent.
prompt_mode: replace            # replace (body IS the prompt) | append (body appended to the base Hoy prompt). Default replace.
model: sonnet                   # optional; fuzzy id resolved by the existing set_model path. Omit = inherit parent's model.
thinking: high                  # optional; off|minimal|low|medium|high|xhigh. Omit = inherit.
---
<markdown body = the agent's system prompt>
```

Unknown frontmatter keys and the deferred fields (`max_turns`, `inherit_context`,
`run_in_background`, `isolation`) are ignored with a loader diagnostic, not a hard
error, so authored files stay forward-compatible.

## Components

### 1. Sidecar registry (runtime authority for tools + prompt)

`packages/sidecar/pi-src/hoy-agents.ts` (and a new `hoy-agents-registry.ts`):

- `loadSubagentRegistry(agentDir, cwd)`: reads built-ins (code), global
  `<agentDir>/agents/*.md`, and project `<cwd>/.hoy/agents/*.md`; parses each with
  Pi's `parseFrontmatter`; layers by precedence (builtin < global < project);
  drops entries disabled in `subagents.json`; validates `tools` against the real
  registered tool set and strips `agent` from every entry (depth cap). Each entry
  keeps its `scope` tag. Returns `Record<name, SubagentType>` where `SubagentType`
  gains `scope`, `promptMode`, `description`, `model?`, `thinking?`, and keeps
  `tools` + `systemPromptOverride` (the body). The loader does NOT gate on trust
  (no `ctx` at load time); trust is enforced at the spawn checkpoint (Safety).
- The parent's `agent` tool: `subagentType` param becomes a dynamic `Type.String`
  validated at `execute()` against the loaded registry (the hardcoded `Type.Union`
  at `hoy-agents.ts:45` is removed). `execute()` also enforces the trust gate.
  `buildHoySystemPrompt` gains the enabled type list so `AGENT_TOOLS_PROMPT`
  advertises names + descriptions dynamically.
- The child factory (`hoy-sidecar.ts:66-75`): `resolveSubagentType(name)` becomes
  a registry lookup; `tools` and `systemPromptOverride` seams are unchanged
  (they already take dynamic values). `prompt_mode: append` composes the body
  with `buildHoySystemPrompt(...)` instead of replacing it.

### 2. One-shot list mode (sidecar) + Rust spawn/capture + enable state

- **Sidecar one-shot** (`hoy-sidecar.ts`, before `runRpcMode`, like the OAuth
  branch): when `HOY_LIST_SUBAGENTS` is set, call `loadSubagentRegistry(agentDir,
  cwd)`, print the resolved registry as a JSON array (name, description, tools,
  model, thinking, promptMode, scope, source path, enabled) to stdout, and exit.
  This is the same resolution runtime uses, so the UI never drifts.
- **Rust `subagents_config.rs`** (JSON, `serde_json` only, no YAML): owns
  `subagents.json` enable/disable state. Format is a per-scope disabled name list
  (`{ "disabled": ["Reviewer"] }`). Atomic read/write cloned from `mcp_config.rs`
  (`MUTATION_LOCK`, 0700/0600, tmp+fsync+rename). Exposes
  `set_enabled(scope, project, name, enabled)`.
- **Rust commands** (`commands.rs`): `list_subagents(cwd, project)` asks a
  `SidecarManager` method to spawn the sidecar binary with `HOY_LIST_SUBAGENTS=1`
  + `PI_CODING_AGENT_DIR` + `current_dir(cwd)` and capture stdout JSON (the OAuth
  spawn is the template); `set_subagent_enabled(scope, project, name, enabled)`
  writes `subagents.json` then `respawn_idle_sessions` so runtime picks up the
  change. `create_session` is unchanged.
- **Model/thinking** are applied entirely renderer-side (see component 4) via the
  proven `applyThreadModel` path; Rust does not touch model/thinking.

### 3. Settings UI

`apps/desktop/src/components/settings/SubagentsPanel.tsx` (mirrors `McpPanel.tsx`):
loads the registry via `listSubagents(cwd)` (Rust one-shot), sections for
Built-in / Global / This project; each row shows name, description, tool badges,
model/thinking, an enable/disable `Switch`, and an "open file" action
(`openPath` from `@tauri-apps/plugin-opener`) for file-backed agents. Built-in
rows have no file to open. Registered via a new `CategoryId` + `CATEGORIES` entry
+ `panels.tsx` case, exactly like MCP.

### 4. Renderer model/thinking application (closes HOY-237)

`spawnChildThread` (`store.ts:774`) currently jumps straight to
`streamPromptOnThread`, skipping model application. Phase 3: the store caches the
registry (`subagents: SubagentDef[]`, refreshed via `listSubagents`); on spawn it
looks up `payload.subagentType`, sets the child `Thread`'s `model` (= the type's
`model` resolved against configured models, else the parent's `model`) and
`thinkingLevel` (= the type's `thinking`, else the parent's), then after
`createSession` resolves calls the proven `applyThreadModel(childId, sessionId)`
(and `applyThreadPermissionMode`) before `streamPromptOnThread`. This reuses the
exact model/thinking reconcile that `submitPrompt` uses, so fuzzy resolution and
fallback are already handled, and a type with no `model` inherits the parent's
(closing HOY-237).

## Safety

- **Project-trust gate**: `ctx.isProjectTrusted()` is only available inside a
  tool's `execute()`, not at load/prompt-build time, so (exactly as MCP gates at
  its connect checkpoint, `hoy-mcp.ts:212`) the gate lives in the `agent` tool's
  `execute()`: when the resolved type's `scope === "project"` and the project is
  untrusted, it throws before the spawn notify, so a cloned untrusted repo's agent
  is loaded and advertised but can never actually run. Global and built-in agents
  are unaffected. The child spawn has no other entry point, so the parent
  `execute()` is the single chokepoint.
- **Depth cap (hard, depth 1)**: the loader strips `agent` from every type's
  tools, so a child can never spawn, regardless of what a `.md` file declares.
  This is Phase 1's cap made explicit and enforced in the registry path.
- **Tool allowlist validation**: a type's `tools` are intersected with the real
  registered built-in set (+ `mcp`); unknown tool names are dropped with a
  diagnostic. Nothing a `.md` file writes can grant a tool that does not exist.
- **Per-type consent** (Phase 1) is unchanged: spawning still routes through the
  `agent` tool's `ctx.ui.select` consent, now naming the resolved type.

## Data flow (spawn with a registry type)

```
parent session start
  -> sidecar loadSubagentRegistry(agentDir, cwd)
     -> built-ins + global + project, enabled only, agent stripped, scope-tagged
  -> agent tool advertises the enabled names+descriptions; validates subagentType

model calls agent({subagentType:"Reviewer", task})
  -> execute(): resolve type; if scope==project && !isProjectTrusted -> throw   [Safety]
  -> consent -> sentinel notify -> Rust SubagentSpawned            [Phase 1]
  -> renderer spawnChildThread: look up "Reviewer" in the cached registry
       -> set child.model (type.model ?? parent.model), child.thinkingLevel
       -> create_session(subagentType)  [unchanged]
       -> applyThreadModel(childId, sessionId)  [proven set_model/set_thinking path]
  -> child sidecar (HOY_SUBAGENT_TYPE=Reviewer) loadSubagentRegistry -> resolve
       -> tools (agent stripped) + prompt (replace|append) applied to its session
  -> child streams; result delivered to parent                    [Phase 2]
```

## Edge cases

- **Malformed `.md` / bad YAML**: the loader skips that file with a diagnostic
  (never crashes the session), mirroring `read_config_at` returning empty on
  malformed MCP config.
- **`tools` names a nonexistent or `agent` tool**: dropped with a diagnostic; the
  rest of the type loads.
- **Name collision across scopes**: project wins over global wins over built-in
  (so a project can specialize `Explore`). The settings UI shows which scope is
  effective.
- **`model` unresolvable** (declared model not configured/authed): the renderer's
  existing `set_model` fallback applies (the child runs the default model); the
  spawn is not failed.
- **Disabled type still requested by the model**: the parent does not advertise
  disabled types, and `agent`'s `execute()` rejects an unknown/disabled type with
  a clear error, exactly like today's unknown-type error.
- **Untrusted project**: project agents load and advertise, but the `agent`
  tool's `execute()` refuses to spawn a project-scoped type when the project is
  untrusted (a clear error, like MCP's untrusted-server error). The UI lists them
  normally; runtime is where trust bites.

## Testing

Sidecar (`bun test`, mirroring `hoy-agents.test.ts` / `hoy-mcp.test.ts`):

- registry precedence (project overrides global overrides built-in by name).
- `agent` stripped from a type that declares it (depth cap).
- unknown/`agent` tool names dropped; valid ones kept.
- disabled types excluded (from `subagents.json`).
- `prompt_mode: append` composes with the base prompt, `replace` overrides it.
- malformed frontmatter skipped with a diagnostic, others still load.
- the `agent` tool's `execute()` refuses a project-scoped type when
  `ctx.isProjectTrusted()` is false; allows global/built-in and, when trusted, a
  project type.

Rust (`cargo test`, mirroring `mcp_config` tests):

- `subagents.json` atomic read-modify-write preserves unknown keys; the disabled
  list round-trips per scope; `set_enabled(false)` adds a name, `set_enabled(true)`
  removes it.

Live-verify in the running app:

- author a `<project>/.hoy/agents/Reviewer.md` (custom tools + prompt); it appears
  in the settings panel; spawn it via the agent tool; the child runs with exactly
  its tools + prompt (and its `model` if set); disable it in settings and confirm
  the parent no longer offers it after respawn; confirm a `prompt_mode: append`
  agent gets the base Hoy prompt plus its body.

## Files (for writing-plans to expand)

Sidecar (TypeScript):
1. `packages/sidecar/pi-src/hoy-agents-registry.ts` (new): `loadSubagentRegistry`,
   frontmatter parse via Pi's `parseFrontmatter`, precedence, tools validation +
   depth strip, disabled overlay from `subagents.json`, scope tags; move the two
   built-ins here as the base layer.
2. `packages/sidecar/pi-src/hoy-agents.ts`: dynamic `subagentType` param
   (`Type.String`); `execute()` resolves via the registry + enforces the trust
   gate; `createHoyAgents(registry)`.
3. `packages/sidecar/pi-src/hoy-sidecar.ts`: factory loads the registry, resolves
   `childType` from it, composes `prompt_mode: append`; one-shot
   `HOY_LIST_SUBAGENTS` mode prints the resolved registry JSON.
4. `packages/sidecar/pi-src/hoy-system-prompt.ts`: `buildHoySystemPrompt` takes the
   enabled type list; `AGENT_TOOLS_PROMPT` advertises it dynamically.
5. Sidecar tests.

Rust (`serde_json` only, no YAML):
6. `apps/desktop/src-tauri/src/subagents_config.rs` (new): `subagents.json`
   enable/disable (per-scope disabled list), atomic read/write cloned from
   `mcp_config.rs`; `set_enabled(scope, project, name, enabled)`.
7. `apps/desktop/src-tauri/src/sidecar.rs`: a `SidecarManager` method that spawns
   the sidecar binary with `HOY_LIST_SUBAGENTS=1` + `PI_CODING_AGENT_DIR` +
   `current_dir(cwd)` and captures stdout (the OAuth spawn is the template).
8. `apps/desktop/src-tauri/src/commands.rs` + `lib.rs`: `list_subagents`,
   `set_subagent_enabled` commands (register in the handler list). `create_session`
   unchanged.
9. Rust tests.

Renderer:
10. `apps/desktop/src/lib/ipc.ts` + `types.ts`: `listSubagents(cwd, project)`,
    `setSubagentEnabled(...)`; `SubagentDef` type (name, description, tools, model,
    thinking, promptMode, scope, source, enabled).
11. `apps/desktop/src/state/store.ts`: cache the registry; `setSubagentEnabled`
    wrapper (clears `modelApplied`/`permissionModeApplied`); `spawnChildThread`
    sets the child's `model`/`thinkingLevel` from the cached def (else parent) and
    calls `applyThreadModel`/`applyThreadPermissionMode` after `createSession`.
12. `apps/desktop/src/components/settings/SubagentsPanel.tsx` (new) +
    `categories.ts` + `panels.tsx` registration.

Verification:
13. `packages/sidecar/build.sh` rebuild; sidecar + cargo + tsc green; live-verify
    per above; commit `HOY-234:` with evidence.
