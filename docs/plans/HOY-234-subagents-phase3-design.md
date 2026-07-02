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

## Architecture: two readers, mirroring MCP

The MCP subsystem is the established pattern and Phase 3 mirrors it exactly: Rust
owns config read/write for the UI and passes nothing semantic to the sidecar; the
sidecar independently loads the same on-disk files for runtime, and applies
merge/trust there. Two readers of the same files, each for its own concern. This
is not duplication to eliminate; it is the project's config pattern
(`mcp_config.rs` + `hoy-mcp.ts` read `mcp.json` independently).

```
.hoy/agents/*.md (project)   ~/.hoy/agent/agents/*.md (global)   in-code built-ins
         |                              |                              |
         +---------------+--------------+---------------+--------------+
                         |                              |
              Rust subagents_registry.rs       sidecar hoy-agents registry
              (serde_yaml, for the UI          (Pi parseFrontmatter, for runtime:
               + create_session model/          parent advertises + validates,
               thinking resolution)             child applies tools + prompt;
                         |                       trust gate + depth cap here)
               list_subagents / set_enabled              |
                         |                       HOY_SUBAGENT_TYPE (name) in
              SubagentsPanel (settings UI)       env selects the child's type
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

- `loadSubagentRegistry(agentDir, cwd, ctx)`: reads built-ins (code), global
  `<agentDir>/agents/*.md`, and, only when `ctx.isProjectTrusted()`, project
  `<cwd>/.hoy/agents/*.md`; parses each with Pi's `parseFrontmatter`; layers by
  precedence; drops entries disabled in `subagents.json`; validates `tools`
  against the real registered tool set and strips `agent` from every entry
  (depth cap). Returns `Record<name, SubagentType>` where `SubagentType` gains
  `promptMode` and keeps `tools` + `systemPromptOverride` (the body).
- The parent's `agent` tool: `subagentType` param becomes a dynamic
  `Type.String` validated at `execute()` against the loaded registry (the
  hardcoded `Type.Union` at `hoy-agents.ts:45` is removed), and
  `AGENT_TOOLS_PROMPT` advertises the enabled type names + descriptions.
- The child factory (`hoy-sidecar.ts:66-75`): `resolveSubagentType(name)` becomes
  a registry lookup; `tools` and `systemPromptOverride` seams are unchanged
  (they already take dynamic values). `prompt_mode: append` composes the body
  with `buildHoySystemPrompt(...)` instead of replacing it.

### 2. Rust registry (UI authority + model/thinking resolution)

`apps/desktop/src-tauri/src/subagents_registry.rs` (mirrors `mcp_config.rs`):

- `serde_yaml` (new dep) parses `.md` frontmatter. `list_subagents(project) ->
  SubagentList { global, project, builtin }` with full metadata (name,
  description, tools, model, thinking, prompt_mode, enabled, scope, path,
  project_trusted). Powers the settings UI; lists project agents even when
  untrusted (with a `project_trusted:false` flag) so the user can see and decide.
- `subagents.json` atomic read/write (the `mcp_config.rs` write pattern:
  `MUTATION_LOCK`, 0700/0600, tmp+fsync+rename) for enable/disable:
  `set_subagent_enabled(scope, project, name, enabled)`.
- `create_session` (`commands.rs`/`sidecar.rs`) resolves `subagent_type` against
  the registry and returns its `model`/`thinking` alongside the `sessionId`, so
  the renderer applies them via the existing `set_model` / `set_thinking_level`
  RPC path (proven, handles fuzzy-name resolution + fallback). Runtime tools +
  prompt still come from the sidecar's own load (env carries only the type name,
  as today).

### 3. Settings UI

`apps/desktop/src/components/settings/SubagentsPanel.tsx` (mirrors `McpPanel.tsx`):
sections for Global / This project / Built-in; each row shows name, description,
tool badges, model/thinking, an enable/disable `Switch`, and actions (view full
config, open the `.md` in the OS editor). An untrusted project shows a banner
explaining its agents are ignored until trusted. Registered via a new
`CategoryId` + `CATEGORIES` entry + `panels.tsx` case, exactly like MCP.

## Safety

- **Project-trust gate**: the sidecar loader loads project `.hoy/agents/*.md` only
  when `ctx.isProjectTrusted()` (the exact gate MCP uses at `hoy-mcp.ts:212`), so
  a cloned untrusted repo cannot define an agent that then runs. Global and
  built-in agents are unaffected. The settings UI still lists untrusted project
  agents (flagged) so the user can inspect them.
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
  -> Rust passes nothing new; sidecar loadSubagentRegistry(agentDir, cwd, ctx)
     -> built-ins + global + (trusted ? project) , enabled only, agent stripped
  -> agent tool advertises the enabled names+descriptions; validates subagentType

model calls agent({subagentType:"Reviewer", task})
  -> consent -> sentinel notify -> Rust SubagentSpawned            [Phase 1]
  -> renderer create_session(subagentType) 
       Rust resolves the type -> returns { sessionId, model, thinking }
  -> renderer applies model/thinking via set_model/set_thinking_level  [proven path]
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
- **Untrusted project**: project agents are not loaded at runtime; if the model
  names one, it resolves as unknown and is rejected. The UI lists them as
  untrusted.

## Testing

Sidecar (`bun test`, mirroring `hoy-agents.test.ts` / `hoy-mcp.test.ts`):

- registry precedence (project overrides global overrides built-in by name).
- `agent` stripped from a type that declares it (depth cap).
- unknown/`agent` tool names dropped; valid ones kept.
- project agents skipped when `isProjectTrusted()` is false; loaded when true.
- disabled types excluded; `prompt_mode: append` composes with the base prompt,
  `replace` overrides it.
- malformed frontmatter skipped with a diagnostic, others still load.

Rust (`cargo test`, mirroring `mcp_config` tests):

- `subagents.json` atomic read-modify-write preserves unknown keys; enable/disable
  round-trips per scope.
- `list_subagents` merges scopes with correct precedence + `enabled`/`trusted`
  flags; malformed `.md` frontmatter yields a skipped entry, not an error.

Live-verify in the running app:

- author a `<project>/.hoy/agents/Reviewer.md` (custom tools + prompt); it appears
  in settings; spawn it; the child runs with exactly its tools + prompt; disable
  it and confirm the parent no longer offers it; mark the project untrusted and
  confirm the project agent disappears from runtime while global/built-in remain.

## Files (for writing-plans to expand)

Sidecar (TypeScript):
1. `packages/sidecar/pi-src/hoy-agents-registry.ts` (new): `loadSubagentRegistry`,
   frontmatter parse via Pi's `parseFrontmatter`, precedence, validation, depth
   strip, trust gate, disabled overlay.
2. `packages/sidecar/pi-src/hoy-agents.ts`: dynamic `subagentType` param + dynamic
   advertisement; `SubagentType` gains `promptMode`; `resolveSubagentType` -> the
   registry.
3. `packages/sidecar/pi-src/hoy-sidecar.ts`: child factory resolves via the
   registry; `prompt_mode: append` composition.
4. `packages/sidecar/pi-src/hoy-system-prompt.ts`: `AGENT_TOOLS_PROMPT` advertises
   the dynamic enabled type list.
5. Sidecar tests.

Rust:
6. `apps/desktop/src-tauri/Cargo.toml`: add `serde_yaml`.
7. `apps/desktop/src-tauri/src/subagents_registry.rs` (new): parse + `subagents.json`
   CRUD + `list_subagents` + model/thinking resolver.
8. `apps/desktop/src-tauri/src/commands.rs` + `sidecar.rs`: `list_subagents`,
   `set_subagent_enabled` commands; `create_session` returns resolved
   model/thinking.
9. Rust tests.

Renderer:
10. `apps/desktop/src/lib/ipc.ts` + `types.ts`: `listSubagents`,
    `setSubagentEnabled`, `SubagentList`/`SubagentDef` types; `createSession`
    returns `{ sessionId, model?, thinking? }`.
11. `apps/desktop/src/state/store.ts`: `spawnChildThread` applies the returned
    model/thinking via the existing model/thinking path before streaming.
12. `apps/desktop/src/components/settings/SubagentsPanel.tsx` (new) +
    `categories.ts` + `panels.tsx` registration.

Verification:
13. `packages/sidecar/build.sh` rebuild; sidecar + cargo + tsc green; live-verify
    per above; commit `HOY-234:` with evidence.
