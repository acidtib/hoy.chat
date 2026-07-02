# TODO

Open work, consolidated from the build spec (PI_DESKTOP_SPEC.md, deleted at MVP
completion; see git history) and FOLLOWUPS.md (same). The MVP (spec M0-M4) is
done and verified; everything below is post-MVP. Items with a Linear ticket are
tracked there; the rest get a ticket when picked up.

## Release blockers

### Windows code signing
Unsigned installers trip SmartScreen (Hermes desktop hit this). Needed before
any Windows distribution; not before.

## Visible gaps

### Real git status in the title bar
The mocked "main" branch chip was removed from `TitleBar.tsx` (a false signal
for a git-native audience; HOY-233). To reinstate it for real: a Rust command
(`git -C <project.path>`) returning branch, dirty flag, stash count; refresh on
active-project change and window focus. Related decision: macOS `titleBarStyle`
(the window runs `decorations: false`, which also removes macOS traffic lights).

### Cross-restart restore of open panels
The sidebar and history restore across restarts; open panels do not, threads
reopen on demand. Decide whether the panel strip should persist.

### Composer and picker accessibility (from the apps/desktop critique)
The message composer is a bespoke `contenteditable` (`role=textbox`) with inline
mention chips (`contenteditable=false` spans) and custom `@`/`/` menus built as
`div`/`button` lists. Screen-reader gaps: chips carry no `aria-label` (announce
only their text); the pickers have no `listbox`/`option` roles, no
`aria-activedescendant`, and focus is deliberately kept in the editor
(`onMouseDown preventDefault`), so SR users get no option announcements or roving
focus. Also verify the settings/other modals have a focus trap + `aria-modal` +
Escape. Decide: add ARIA roles/roving semantics to the existing contenteditable,
or move to a textarea + token model. Largest remaining item from the critique
(Sam persona); needs its own focused pass.

### Provider state taxonomy (from the apps/desktop critique)
`ProvidersPanel` uses five overlapping verbs/states: Connect, Reconnect, Signed
in, Add key, Saved key. "Signed in" appears in both the subscription block and
the API-keys list (a provider like Anthropic authed via OAuth shows in both),
which is ambiguous about subscription-vs-key auth. Settle a consistent vocabulary
per axis (e.g. subscriptions: Connect / Connected; keys: Add key / Key saved) and
disambiguate the dual appearance.

## Features not built yet

### OAuth login (Claude Pro/Max, ChatGPT, Copilot) - implemented
Pi's RPC has no auth command, so login runs as a one-shot invocation of the
sidecar binary (HOY_OAUTH_LOGIN) driving AuthStorage.login over a small
manual-paste JSONL protocol; Rust bridges it to the renderer over an OAuthEvent
Channel (oauth.rs, events::OAuthEvent, OAuthLoginDialog). On desktop the flow's
local callback server catches the browser redirect automatically, so the common
path needs NO paste; manual code entry is a tucked-away fallback for a browser
on another machine. Anthropic (Claude Pro/Max) verified end-to-end live (zero
paste, auth.json flips to type:"oauth", idle sidecars respawn). Still to
live-verify against real accounts: openai-codex (the login-method select renders)
and github-copilot (device-code). The OAuth identity edge is resolved (pi-ai
injects the Claude Code identity as system[0] for OAuth tokens itself, HOY-185).

### Session import (history view)
Zed's history view has an import action; ours shipped without it. Pi supports
importing a session JSONL (`AgentSessionRuntime.importFromJsonl`), so only the
`ThreadHistory` UI action and a Rust command to adopt a file into a project are
missing.

### Disk extension / skill discovery from the branded agent dir (HOY-228)
`DefaultResourceLoader` can auto-discover extensions/skills from `~/.hoy/agent`,
but disk `.ts` extensions need `jiti` + `typebox` resolvable at runtime inside
the bun-compiled sidecar (zosma-cowork shipped this broken, their #151/#152).
Confirm bundling, add an end-to-end disk-extension test, decide install UX.
Until then do not claim extension support.

### MCP support v2 (deferred from HOY-232)
HOY-232 ships MCP as an in-process `createHoyMcp` extension (single `mcp` proxy
tool, branded config, React settings UI, per-server consent). These were
explicitly deferred to a v2 pass and should get their own tickets when picked up:
- Direct-tool promotion: expose selected MCP tools as real named tools (not only
  via the `mcp` proxy), so the model can call them directly and the permission
  gate sees per-tool names instead of the single `mcp` name.
- OAuth flows for HTTP MCP servers (v1 handles stdio/http with `${ENV}` secrets
  only).
- Elicitation rendering (server-driven prompts back to the user).
- MCP-UI windows (server-provided UI surfaces).
- Sampling (server requests a model completion through us).
- Cross-session server sharing (v1 keeps servers per-session; share/keep-alive a
  connected server across sessions).

### In-process custom tools
We own the sidecar entry, so Hoy-specific tools can register via
`extensionFactories` with no RPC marshaling (zosma's office-docs pattern).
Needs a first concrete tool to justify the surface; the permission gate already
fails safe for unknown tools.

### Memory system
Spike ticket HOY-202 (backlog): research Windsurf/Claude Code/Cursor/opencode
memory approaches, recommend a Hoy MVP (likely project-scoped markdown
memories, index injection, a memory tool gated like edit/write).

### Filter thinking levels to model capabilities (HOY-204 follow-up)
The thinking dropdown always shows all six levels (off/minimal/low/medium/high/xhigh),
but Pi clamps unsupported levels internally. DeepSeek maps low/medium to high and
xhigh to max; other providers differ. Needed: query `getSupportedThinkingLevels` per
model and only show the supported set in the PillSelect. The post-`set_thinking_level`
sync (store.ts) already corrects the local state after clamping; this would prevent
the optimistic flash entirely.

## Upstream (pi)

### Groq drops the system prompt for reasoning models
pi-ai's openai-completions provider sends the system prompt as role `developer`
when `model.reasoning && supportsDeveloperRole`; Groq is not in the
`isNonStandard` list, so Groq reasoning models (verified live, Qwen3 32B)
silently lose the entire system prompt: no Hoy identity, no tool guidelines.
Report upstream (Groq needs `supportsDeveloperRole: false` or a compat
carve-out) and re-verify after the pi bump that picks up a fix.

### Pi version bump checklist
Pinned 0.80.3. On every bump: re-verify the tool promptGuidelines in
`hoy-system-prompt.ts` against pi source (the edit guidelines are load-bearing),
repoint the docs-block GitHub tag, re-check the provider list and env-var
mapping in `pi_config.rs`, and re-run the prompt assembly tests.

### /tree navigator UI (follow-up to HOY-221)
The read surface for the session tree is wired: `get_entries` and `get_tree` RPC
commands land as Rust commands (`commands.rs`), typed `invoke` wrappers
(`lib/ipc.ts`), and TS types (`lib/types.ts`) mirroring Pi's `SessionEntry` /
`SessionTreeNode`. Still to build: the `/tree` navigator UI that consumes them,
and the `fork` / `clone` / `get_fork_messages` write side for branching. Coverage
recorded in `docs/pi-rpc-coverage.md` ("Bump review: 0.80.2 -> 0.80.3").

### Pre-existing provider-list gaps (noted during HOY-221, not a 0.80.3 delta)
Pi's `core/provider-display-names.js` lists `ant-ling`, `nvidia`, and
`zai-coding-cn`, which are absent from `pi_config.rs` PROVIDERS, and Pi's `zai`
label is now "ZAI Coding Plan (Global)" (pi_config has "ZAI"). These predate the
0.80.3 bump (the CHANGELOG lists no provider additions). Reconcile `pi_config.rs`
with Pi's built-in table, sourcing the correct env-var names, when convenient.

## Deferred by design (MVP scope cuts)

Themes, keyboard shortcuts, session rename/delete polish, the multi-session
orchestration dashboard (spec M5: per-thread status overview, cross-thread
coordination; the architecture keeps it open, everything is keyed by
sessionId). Build when wanted, nothing blocks them.
