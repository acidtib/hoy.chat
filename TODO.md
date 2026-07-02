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
The branch chip in `TitleBar.tsx` is a static mock ("main"). Needed: a Rust
command (`git -C <project.path>`) returning branch, dirty flag, stash count;
refresh on active-project change and window focus. Related decision: macOS
`titleBarStyle` (the window runs `decorations: false`, which also removes
macOS traffic lights).

### Cross-restart restore of open panels
The sidebar and history restore across restarts; open panels do not, threads
reopen on demand. Decide whether the panel strip should persist.

## Features not built yet

### OAuth login (Claude Pro/Max, Copilot)
The SDK exposes login flows the old binary did not; the providers panel shows
"Coming soon". The OAuth identity edge is resolved (pi-ai injects the Claude
Code identity as system[0] for OAuth tokens itself, verified by source
inspection in HOY-185), but no live OAuth round-trip has been done; re-verify
when the first real OAuth credential is configured.

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
