# AGENTS.md: Hoy

Project conventions and guardrails. Open work is tracked in Linear. This file is the short, always-loaded version: the decisions that must not drift.

## What we're building
A real desktop GUI for the **Pi coding agent** (`@earendil-works/pi-coding-agent`). Tauri v2 shell + React/TS webview + Pi running as a **spawned sidecar** over its RPC (JSONL-over-stdio) protocol. The sidecar is our own thin SDK entry running Pi's `runRpcMode` (see below), not the stock CLI. Same three-layer architecture as OpenAI's Codex desktop app (renderer → Rust main → spawned agent process), deliberately.

Repo is a Bun-workspaces monorepo (HOY-227): `hoy.chat` at the root, the desktop app under `apps/desktop/` (`src/` renderer, `src-tauri/` Rust core), the Pi sidecar under `packages/sidecar/` (`pi-src/` + `build.sh`), and the marketing site under `apps/site/` (Next.js, separate stack from the Tauri app). Run everything from the root via delegating scripts (`bun run tauri:dev`, `bun run check`, `bun run test`).

## Commands (run from repo root)
- `bun run tauri:dev`: the ONLY dev entry (see landmines: enables `withGlobalTauri` + hoyd namespace for dev).
- `bun run check`: desktop TS + Rust (`check:ts`, `check:rust`, `clippy`, `check:fmt`) plus sidecar TS. Does NOT cover `apps/site`.
- `bun run test`: desktop `bun test`.
- `bun run lint`: `oxlint src` + rust clippy.
- `cd packages/sidecar/pi-src && bun test`: the sidecar extension tests (not part of `bun run test`; `apps/desktop/bunfig.toml` excludes them).
- `bun packages/sidecar/pi-src/smoke/smoke-test.ts packages/sidecar/hoy-pi-<triple>`: smoke-test the compiled sidecar binary (RPC, MCP, codemode, permission gate, OAuth loaders). CI runs it on every platform (`docs/CI.md`).
- `bun run check:pr-title '<title>'`: validate a PR title (see "Commits and pull requests").
- `bun run sidecar:build`: rebuild the Pi sidecar binary (delegates to `packages/sidecar/build.sh`). Required after ANY `packages/sidecar/pi-src` change, before live-verify (a stale binary runs old prompt/gate code, HOY-200).
- `bun run site:dev`: the marketing site (Next.js; also `site:build`, `site:start`, `site:lint`). All root scripts delegate to a workspace via `bun run --filter`.

## Non-negotiable decisions (do NOT re-litigate)
- **Stack is fixed:** Tauri v2 (Rust core), React + TypeScript + Vite, Bun as the frontend package manager/bundler. Do not propose Electron, swap frameworks, or "simplify" by changing this. The tradeoffs were already worked through.
- **UI is shadcn/ui + AI Elements** (`elements.ai-sdk.dev`), a shadcn-based registry of AI-app blocks (Conversation, Message, Prompt Input, Tool, Model Selector, Context, etc.). Use them as the component foundation.
- **Do NOT install or wire up the Vercel AI SDK.** AI Elements is *designed* to pair with the AI SDK (`useChat`, its streaming hooks), but we are not using it; tokens stream from Pi over the Tauri Channel as our own `AgentEvent` type. Use AI Elements blocks as **presentational shadcn components driven by our state**. Never `npm install ai` / `@ai-sdk/*` or bind components to `useChat`; that reintroduces an in-process agent data layer we explicitly rejected. Quarantine any AI-SDK prop-shape adaptation in a thin mapper in `lib/`.
- **Do NOT embed Pi in-process.** Pi runs as a separate spawned process we talk to over stdin/stdout. This is intentional; it matches shipping products and keeps multi-agent orchestration clean. Never reimplement Pi's agent logic in Rust or TS.
- **The sidecar is OUR entry calling Pi's SDK, not the stock `pi` CLI.** We spawn `packages/sidecar/pi-src/hoy-sidecar.ts` (bun-compiled), which builds a runtime via `createAgentSessionServices` + `createAgentSessionFromServices` and hands it to Pi's `runRpcMode`. This is still a separate spawned process over stdio (not embedded), and we still do NOT reimplement Pi's agent loop, `runRpcMode` is Pi's and owns the full command surface (`prompt`, `set_model`, `get_available_models`, `steer`, `fork`, ...). We own the entry purely to brand the agent and inject a resource loader. Branding goes through `appendSystemPromptOverride` (a `systemPromptOverride`/`customPrompt` REPLACES Pi's default coding prompt and strips tool guidelines). The Rust↔sidecar JSONL protocol is unchanged.
- **We extend Pi with in-process extension factories, not disk resources, npm packages, or a fork.** Every Hoy-specific tool, `/` command, or lifecycle hook is a `createHoyX(...)` factory in `packages/sidecar/pi-src/` returning `(pi: ExtensionAPI) => { pi.registerTool | pi.registerCommand | pi.on(...) }`, added to the `extensionFactories` array in `hoy-sidecar.ts` and compiled into the sidecar binary. Canonical examples: `createHoyPermissions`, `createHoyAgents`, `createHoyAskQuestion`, `createHoyTurnBudget` (each with a sibling `*.test.ts`). This is *the* way we add agent features. Do NOT build a Hoy feature as a disk-seeded Pi extension under `~/.hoy/extensions`, as a separate installable package, or by patching Pi. Pi's own disk discovery of `~/.hoy/{extensions,skills,prompts}` exists (proven, HOY-228) but is a *user* affordance, not how Hoy ships its own capabilities. Where Pi ships the capability itself as an exported extension (MCP via `createMcpExtension` + `createToolSearchExtension`), add Pi's factory to the same array and adapt it through its options (`hoy-mcp-config.ts`) rather than reimplementing it.
- **Streaming uses a Tauri `Channel`, never `emit`/`listen`.** Tauri's event system is not for high-throughput streaming; channels are. Token deltas go over a channel.
- **Sidecar state is keyed by `sessionId` from day one**, even though the MVP has one session. This is what keeps the orchestration endgame open. Do not hardcode a single-session assumption anywhere.
- **Subagents are SYNCHRONOUS (HOY-300), not fire-and-forget.** The `agent` tool blocks on `ctx.ui.input("@hoy/spawn-subagent-sync:…")` and returns the child's result in-band (like Claude Code's Task tool); the child is still a watchable first-class thread, and on its `done` the renderer answers the parent's blocked request via `respond_permission`→`respond_ui`. Keep the `agent` tool non-`sequential` so Pi runs parallel tool calls concurrently (→ parallel subagents). Do NOT reintroduce async turn-injection / auto-wake delivery: it buries terminal artifacts (plan mode's `<proposed_plan>` must be the last turn so its card is actionable).

## Critical technical landmines
- **JSONL framing:** Pi's RPC is strict JSONL delimited by `\n` ONLY. Do NOT use a line reader that splits on Unicode separators (U+2028 / U+2029); they are valid inside JSON strings and will corrupt messages. Split on `\n` in Rust, strip a trailing `\r`. There must be a unit test for this against a payload containing U+2028 inside a string value.
- **API keys are written to Pi's `auth.json` (mode 0600) in Hoy's branded dir, never to the renderer.** Decision (M2): Pi's RPC has no auth command and Pi's `getApiKey` resolves `auth.json` above env vars, so we drive Pi's existing credential store directly instead of inventing a parallel keychain/Stronghold layer or env-injection plumbing. All key handling is isolated in `pi_config.rs`: read-modify-write must preserve existing `oauth` entries (a Hoy/`pi` login) and write atomically. After a write, respawn the sidecar so it reloads. Key values never flow back to the renderer; only configured/not-configured status (`ProviderAuth`) does. The dir is **branded and isolated: `~/.hoy`, NOT `~/.pi`** (override with `HOY_AGENT_DIR`; debug builds use `~/.hoyd`, see the dev-namespace bullet). HOY-255 flattened this: the agent dir is `~/.hoy` *directly*, the legacy `~/.hoy/agent/` nesting is gone (`migrate_flatten_agent_dir` moves any leftover contents up one level). Rust writes there; `sidecar.rs` passes the same path to the sidecar as `HOY_CODING_AGENT_DIR` (HOY-261; the payload sets `piConfig.name="hoy"`, so Pi derives that same env name), which our SDK entry honors, so both ends agree. The sidecar is also spawned with a sanitized environment (`env_clear` + allowlist, HOY-261) so an ambient env var can't steer Pi. The earlier keychain-plus-env-injection plan was dropped on purpose. The project-level config dir is also branded: `.hoy/` (not `.pi/`), driven by `piConfig.configDir` rewritten into the sidecar payload `package.json` at build time (HOY-222); `packages/sidecar/build.sh` sets it and asserts it.
- **Pi's install telemetry is forced off.** `enableInstallTelemetry` defaults to `true` upstream, which tags outbound requests to OpenRouter/NVIDIA NIM/Cloudflare/Vercel AI Gateway with `"pi"`/`pi.dev` attribution headers. `apply_sanitized_env` (`sidecar.rs`) sets `PI_TELEMETRY=0` unconditionally on every spawn (RPC session, OAuth login, list_subagents) so this can't leak Pi's branding regardless of host env or a stale `settings.json`. Keep this set if `apply_sanitized_env` is ever refactored.
- **Pin Pi's version exactly.** Its SDK/RPC surface is still evolving. Confirm exact RPC command names and fields against the installed version (pinned 1.3.0) before relying on them. Version-bump checklist in `docs/pi-version-bump.md`.
- **Run dev with `bun run tauri:dev`.** `withGlobalTauri` is `false` in the base `tauri.conf.json` (it is pure attack surface in release). The dev MCP bridge's `execute_js` returns results via `window.__TAURI__` inside the webview, so `tauri:dev` merges `apps/desktop/src-tauri/tauri.dev.conf.json` to turn it on for dev only (it also forces `GDK_BACKEND=x11` for WebKitGTK stability on Wayland). Plain `tauri dev` and release builds keep it off, and with it off every driver `execute_js` times out (the bridge can't emit its result) while backend calls still work. Do not flip the base flag back to `true`; use `bun run tauri:dev`.
- **Dev runs in the `hoyd` namespace so Hoy can work on Hoy (HOY-206).** Debug builds default the agent dir to `~/.hoyd` (`pi_config.rs`, `cfg!(debug_assertions)` picks `BRANDED_DIR`), and `tauri.dev.conf.json` overrides the identifier to `chat.hoy.desktop.dev` (separate window-state and webview storage) with productName `Hoyd Desktop`. A dev instance never touches production data in `~/.hoy`. The dev namespace starts empty; copy `~/.hoy/auth.json` into `~/.hoyd/` to reuse keys. Caveat: plain `tauri dev` gets the debug agent dir but the prod identifier, one more reason `bun run tauri:dev` is the only dev entry.

- **Live-verify through the DOM, not module imports.** In the dev webview, `import('/src/state/store.ts')` from `execute_js` can return a fresh module instance after HMR, not the app's store; writes to it change nothing on screen. Drive the UI (click, type) and read the DOM instead. Editing `src-tauri/` while `tauri:dev` runs rebuilds and restarts the app, dropping the bridge until it is back.
- **The dev app runs a copy of the sidecar.** Tauri's `externalBin` copies `packages/sidecar/hoy-pi-<triple>` to `src-tauri/target/debug/hoy-pi` only when the Rust side rebuilds, so a `sidecar:build` made after that keeps running old code. Swap the copy in by rename (`cp <new> hoy-pi.new && mv -f hoy-pi.new hoy-pi`; a plain `cp` fails with "Text file busy" while sessions run), or touch a Rust file.
- `components/ThreadView.tsx` contains a literal NUL (the `ASK_OTHER` sentinel), so plain `grep` treats it as binary and prints nothing. Use `grep -a`.

## Working process
- **The MVP milestones (M0-M4) are done.** Post-MVP work flows through Linear tickets: assign, In Progress, design note, implement, test, live-verify via the tauri MCP bridge, open a PR (see "Commits and pull requests"), squash-merge it, Done with evidence.
- **Rebuild the sidecar binary (`bun run sidecar:build`) whenever `packages/sidecar/pi-src` changes**, before any live verification, then open a **new session/thread** to pick it up: a running session keeps the sidecar it already spawned, so prompt/gate edits only reach freshly-spawned sessions. A stale binary, or a still-running old session, silently runs old prompt and gate code (HOY-200).
- **Keep frontend and backend contracts in sync.** The `AgentEvent` union and command signatures are the source of truth shared between Rust `events.rs` and TS `types.ts`. Change both together.

## Code conventions
- Rust: keep sidecar/process logic in `sidecar.rs` + `reader.rs`; `#[tauri::command]` fns in `commands.rs`; Pi config and credential file handling isolated in `pi_config.rs`. Prefer `Result` returns and surface errors to the frontend as structured events, not panics.
- TS: typed wrappers around `invoke()` live in `lib/ipc.ts`; never call `invoke` with stringly-typed args scattered through components. Shared types in `lib/types.ts` mirror the Rust event/command shapes.
- TS test files under `apps/desktop/tests/` may show editor `@/...` "cannot find module" / implicit-`any` diagnostics; these are false positives (tsconfig `include` is `src`-only). `bun test` and `bun run check:ts` are authoritative; don't chase them.
- UI: sidebar of projects and threads, thread tabs in the title bar, streaming transcript, composer with the model picker. Render the session list even when there's one session.
- Agents: the built-in roster is `BUILTIN_SUBAGENTS` in `packages/sidecar/pi-src/hoy-agents-registry.ts`. Adding, renaming or retiring a built-in also updates `BUILTIN_NAMES` (`src-tauri/src/subagents_config.rs`), `BUILTIN_SUBAGENT_NAMES` (`components/settings/SubagentEditor.tsx`), and the retired-name map in `lib/fleet.ts` (mirrors `RETIRED_SUBAGENTS`).
- Prompts are layered in `hoy-system-prompt.ts` (`buildHoySystemPrompt({ tools, run, agentTypes })`): base (lists only the session's tools), run context, then the role body appended by `effectiveChildPrompt`. Run context comes from type + depth: no type = interactive, type at depth 0 = Fleet run, deeper = subagent. A role spawns only its `spawns` list.
- Renaming a persisted renderer pref: bump `version` and extend `migratePrefs` in `state/prefs.ts`, or users silently lose the setting.

## Design context
- Each frontend workspace carries its own `PRODUCT.md` (strategy: register, users, brand, principles, a11y) and `DESIGN.md` (visual system: tokens, type, components, layout), maintained via the impeccable skill. Read them before any UI work; keep them in sync when the visual system changes.
- `apps/desktop` register is **product**: dark-first layered near-black, **square theme** (`--radius: 0`), indigo/violet brand accent, shadcn/ui + AI Elements, the transcript is the focal surface.
- `apps/site` register is **brand**: marketing landing mirroring the desktop dark identity, softer `10px` radius, amber reserved for beta/honesty signals.
- Live-mode config for both lives at `<app>/.impeccable/live/config.json`.

## Writing style and output rules
- No emojis anywhere: not in code, comments, docs, commit messages, or any output.
- No em dashes anywhere: code, comments, docs, commits, PRs. Use a hyphen, comma, or semicolon.
- No over-summarizing. Do not recap what you just did at the end of a response. Do not add closing paragraphs restating the changes. The diff speaks for itself.

## Comments
Write comments the way a human working under deadline pressure would: short, and only when the line above genuinely needs it. Default to no comment.
- **One clause, not a paragraph.** If a comment needs three lines to justify itself, cut it down to the one fact that matters.
- **Describe the code as it stands.** Don't narrate the bug that led to it or why you chose this fix; that belongs in the commit message.
- **Only comment the non-obvious**: a hidden platform constraint, a subtle invariant, a workaround for a specific bug, a Pi behavior we depend on. Never what the code visibly does. If removing the comment wouldn't confuse a future reader, don't write it.
- **Don't point at docs.** No "see docs/RELEASING.md" in code. Docs move and the comment rots; state the fact the reader needs. Ticket ids (`HOY-NNN`) are fine as a pointer to the decision.
- **One comment per block, not per line.**

## Commits and pull requests
Small commits. Never commit secrets, `auth.json`, or any `.env`. Only commit when asked; finish and verify the work first. Commits and PR titles are Conventional Commits:

```
<type>(<scope>): <description>

[optional body]
```

PRs are squash merged, so the PR title becomes the commit on `main`, and Release Please turns it into the version bump and the changelog line. Merging to `main` doesn't release the app; merging the release PR does (`apps/site` changes deploy on merge). Check a title with `bun run check:pr-title '<title>'`; the required `conventional-title` check runs the same script, with types read from `release-please-config.json`.

- **Type**: what the change is. It decides whether it ships:
  - `feat`: something a user of the desktop app (or a site visitor) can see or do
  - `fix`: a bug fix
  - `perf`: faster, same behavior
  - `deps`: dependency updates that reach the shipped app (Dependabot uses this)
  - `revert`: undoes an earlier commit
  - `refactor`, `build`, `docs`, `test`, `ci`, `chore`, `style`: never released on their own and left out of the changelog. Don't use them for anything users need: a Pi bump that changes behavior is `feat` or `fix`, not `chore`.
  - Add `!` after the scope for a breaking change (`feat(core)!: ...`). While on `0.x`, `feat` and `fix` bump the patch and a breaking change bumps the minor.
- **Scope**: the area touched, lowercase; optional. One of:
  - `ui`: `apps/desktop/src/` (renderer)
  - `core`: `apps/desktop/src-tauri/` (Rust: sidecar process, IPC, config files)
  - `sidecar`: `packages/sidecar/` (Pi entry, Hoy extensions, build)
  - `site`: `apps/site/`
  - `pi`: Pi version and integration changes spanning sidecar, core, and ui
  - `mcp`: MCP across the sidecar loader, `mcp_config.rs`, and the settings panel
  - `auth`: API keys and OAuth across `pi_config.rs`, `oauth.rs`, the sidecar, and the ui
  - `config`: root `package.json`, `bun.lock`, `tsconfig`, `.gitignore`, `.mcp.json`, `.claude/`, `.agents/`
  - None for docs (`docs: ...`), CI (`ci: ...`), tests (`test: ...`), or changes that touch everything.
- **Several scopes**: use the narrowest one that covers the change. If it really spans several, comma-separate them (`feat(sidecar,ui): ...`).
- **Description**: lowercase, imperative, no trailing period. It's the changelog line, so say what changed for the user, not what bug prompted it.
- **Body**: optional, for the why a future reader needs. Same restraint as comments; don't narrate the debugging. Squash merges keep only the title unless you type a body into the merge dialog, which is also where `Release-As: X.Y.Z` and `BREAKING CHANGE:` footers go.
- **One PR, one change.** A PR mixing a feature and an unrelated fix gets one title and one changelog line; split it.
- **Linear ticket**: reference `HOY-NNN` in the PR description (Linear links it), not in the title.
- **PR description**: what changed and why in a few lines, how it was verified (`bun run check`, `bun run test`, sidecar tests, smoke test, live-verify via the tauri MCP bridge, screenshots for UI), and anything a reviewer must look at (`auth.json` handling, the sanitized sidecar env, permission gate, release workflows). No file-by-file narration.
- Never edit version fields or push `v*` tags by hand; Release Please owns them (`docs/RELEASING.md`).
- No co-author trailers (`Co-authored-by`, `Co-committed-by`, or similar).
- No tool attribution anywhere: no "Generated with" lines, agent or session links, or co-author trailers in commits, pull requests, issues, or comments.

## Out of scope for MVP (note as TODOs, don't build)
Themes, keyboard shortcuts, session rename/delete polish, Windows code signing. The architecture must not *block* these, but they are not MVP work. (The orchestration dashboard is now the v2 Fleet, in progress.)

## Definition of done (MVP)
Launch → enter API key (written to Pi's `auth.json`, mode 0600, never shown to the renderer) → real models populate and one is selectable → type a message and watch it stream token-by-token → see tool calls render → past session appears in the sidebar after restart.
