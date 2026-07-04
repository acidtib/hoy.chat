# AGENTS.md — Hoy

Project conventions and guardrails. Open work is tracked in `TODO.md` and Linear. This file is the short, always-loaded version: the decisions that must not drift.

## What we're building
A native desktop GUI for the **Pi coding agent** (`@earendil-works/pi-coding-agent`). Tauri v2 shell + React/TS webview + Pi running as a **spawned sidecar** over its RPC (JSONL-over-stdio) protocol. The sidecar is our own thin SDK entry running Pi's `runRpcMode` (see below), not the stock CLI. Same three-layer architecture as OpenAI's Codex desktop app (renderer → Rust main → spawned agent process), deliberately.

Repo is a Bun-workspaces monorepo (HOY-227): `hoy.chat` at the root, the desktop app under `apps/desktop/` (`src/` renderer, `src-tauri/` Rust core), the Pi sidecar under `packages/sidecar/` (`pi-src/` + `build.sh`). Run everything from the root via delegating scripts (`bun run tauri:dev`, `bun run check`, `bun run test`). More apps land under `apps/` (a landing site is planned).

## Non-negotiable decisions (do NOT re-litigate)
- **Stack is fixed:** Tauri v2 (Rust core), React + TypeScript + Vite, Bun as the frontend package manager/bundler. Do not propose Electron, swap frameworks, or "simplify" by changing this. The tradeoffs were already worked through.
- **UI is shadcn/ui + AI Elements** (`elements.ai-sdk.dev`), a shadcn-based registry of AI-app blocks (Conversation, Message, Prompt Input, Tool, Model Selector, Context, etc.). Use them as the component foundation.
- **Do NOT install or wire up the Vercel AI SDK.** AI Elements is *designed* to pair with the AI SDK (`useChat`, its streaming hooks), but we are not using it — tokens stream from Pi over the Tauri Channel as our own `AgentEvent` type. Use AI Elements blocks as **presentational shadcn components driven by our state**. Never `npm install ai` / `@ai-sdk/*` or bind components to `useChat`; that reintroduces an in-process agent data layer we explicitly rejected. Quarantine any AI-SDK prop-shape adaptation in a thin mapper in `lib/`.
- **Do NOT embed Pi in-process.** Pi runs as a separate spawned process we talk to over stdin/stdout. This is intentional; it matches shipping products and keeps multi-agent orchestration clean. Never reimplement Pi's agent logic in Rust or TS.
- **The sidecar is OUR entry calling Pi's SDK, not the stock `pi` CLI.** We spawn `packages/sidecar/pi-src/hoy-sidecar.ts` (bun-compiled), which builds a runtime via `createAgentSessionServices` + `createAgentSessionFromServices` and hands it to Pi's `runRpcMode`. This is still a separate spawned process over stdio (not embedded), and we still do NOT reimplement Pi's agent loop, `runRpcMode` is Pi's and owns the full command surface (`prompt`, `set_model`, `get_available_models`, `steer`, `fork`, ...). We own the entry purely to brand the agent and inject a resource loader. Branding goes through `appendSystemPromptOverride` (a `systemPromptOverride`/`customPrompt` REPLACES Pi's default coding prompt and strips tool guidelines). The Rust↔sidecar JSONL protocol is unchanged.
- **Streaming uses a Tauri `Channel`, never `emit`/`listen`.** Tauri's event system is not for high-throughput streaming; channels are. Token deltas go over a channel.
- **Sidecar state is keyed by `sessionId` from day one**, even though the MVP has one session. This is what keeps the orchestration endgame open. Do not hardcode a single-session assumption anywhere.

## Critical technical landmines
- **JSONL framing:** Pi's RPC is strict JSONL delimited by `\n` ONLY. Do NOT use a line reader that splits on Unicode separators (U+2028 / U+2029) — they are valid inside JSON strings and will corrupt messages. Split on `\n` in Rust, strip a trailing `\r`. There must be a unit test for this against a payload containing U+2028 inside a string value.
- **API keys are written to Pi's `auth.json` (mode 0600) in Hoy's branded dir, never to the renderer.** Decision (M2): Pi's RPC has no auth command and Pi's `getApiKey` resolves `auth.json` above env vars, so we drive Pi's existing credential store directly instead of inventing a parallel keychain/Stronghold layer or env-injection plumbing. All key handling is isolated in `pi_config.rs`: read-modify-write must preserve existing `oauth` entries (a Hoy/`pi` login) and write atomically. After a write, respawn the sidecar so it reloads. Key values never flow back to the renderer; only configured/not-configured status (`ProviderAuth`) does. The dir is **branded and isolated: `~/.hoy/agent`, NOT `~/.pi`** (override with `HOY_AGENT_DIR`; debug builds use `~/.hoyd/agent`, see the dev-namespace bullet). Rust writes there; `sidecar.rs` passes the same path to the sidecar as `HOY_CODING_AGENT_DIR` (HOY-261; the payload sets `piConfig.name="hoy"`, so Pi derives that same env name), which our SDK entry honors, so both ends agree. The sidecar is also spawned with a sanitized environment (`env_clear` + allowlist, HOY-261) so an ambient env var can't steer Pi. The earlier keychain-plus-env-injection plan was dropped on purpose. The project-level config dir is also branded: `.hoy/` (not `.pi/`), driven by `piConfig.configDir` rewritten into the sidecar payload `package.json` at build time (HOY-222); `packages/sidecar/build.sh` sets it and asserts it.
- **Pi's install telemetry is forced off.** `enableInstallTelemetry` defaults to `true` upstream, which tags outbound requests to OpenRouter/NVIDIA NIM/Cloudflare/Vercel AI Gateway with `"pi"`/`pi.dev` attribution headers. `apply_sanitized_env` (`sidecar.rs`) sets `PI_TELEMETRY=0` unconditionally on every spawn (RPC session, OAuth login, list_subagents) so this can't leak Pi's branding regardless of host env or a stale `settings.json`. Keep this set if `apply_sanitized_env` is ever refactored.
- **Pin Pi's version exactly.** Its SDK/RPC surface is still evolving. Confirm exact RPC command names and fields against the installed version (pinned 0.80.3) before relying on them. Version-bump checklist in `TODO.md`.
- **Run dev with `bun run tauri:dev`.** `withGlobalTauri` is `false` in the base `tauri.conf.json` (it is pure attack surface in release). The dev MCP bridge needs `window.__TAURI__`, so `tauri:dev` merges `apps/desktop/src-tauri/tauri.dev.conf.json` to turn it on for dev only. Plain `tauri dev` and release builds keep it off. Do not flip the base flag back to `true`.
- **Dev runs in the `hoyd` namespace so Hoy can work on Hoy (HOY-206).** Debug builds default the agent dir to `~/.hoyd/agent` (`pi_config.rs`, `cfg!(debug_assertions)`), and `tauri.dev.conf.json` overrides the identifier to `chat.hoy.desktop.dev` (separate window-state and webview storage) with productName `Hoyd Desktop`. A dev instance never touches production data in `~/.hoy`. The dev namespace starts empty; copy `~/.hoy/agent/auth.json` into `~/.hoyd/agent/` to reuse keys. Caveat: plain `tauri dev` gets the debug agent dir but the prod identifier, one more reason `bun run tauri:dev` is the only dev entry.

## Working process
- **The MVP milestones (M0-M4) are done.** Post-MVP work flows through Linear tickets: assign, In Progress, design note, implement, test, live-verify via the tauri MCP bridge, commit to main with a `HOY-NNN:` prefix, Done with evidence.
- **Rebuild the sidecar binary (`packages/sidecar/build.sh`) whenever `packages/sidecar/pi-src` changes**, before any live verification. A stale binary silently runs old prompt and gate code (HOY-200).
- **Keep frontend and backend contracts in sync.** The `AgentEvent` union and command signatures are the source of truth shared between Rust `events.rs` and TS `types.ts`. Change both together.

## Code conventions
- Rust: keep sidecar/process logic in `sidecar.rs` + `reader.rs`; `#[tauri::command]` fns in `commands.rs`; Pi config and credential file handling isolated in `pi_config.rs`. Prefer `Result` returns and surface errors to the frontend as structured events, not panics.
- TS: typed wrappers around `invoke()` live in `lib/ipc.ts`; never call `invoke` with stringly-typed args scattered through components. Shared types in `lib/types.ts` mirror the Rust event/command shapes.
- UI: match the reference layout (sidebar of sessions / top bar with model + settings / streaming transcript / composer). Render the session list even when there's one session.

## Design context
- Each frontend workspace carries its own `PRODUCT.md` (strategy: register, users, brand, principles, a11y) and `DESIGN.md` (visual system: tokens, type, components, layout), maintained via the impeccable skill. Read them before any UI work; keep them in sync when the visual system changes.
- `apps/desktop` register is **product**: dark-first layered near-black, **square theme** (`--radius: 0`), indigo/violet brand accent, shadcn/ui + AI Elements, the transcript is the focal surface.
- `apps/site` register is **brand**: marketing landing mirroring the desktop dark identity, softer `10px` radius, amber reserved for beta/honesty signals.
- Live-mode config for both lives at `<app>/.impeccable/live/config.json`.

## Writing style and output rules
- No emojis anywhere: not in code, comments, docs, commit messages, or any output.
- No em-dashes (--). Use a comma, semicolon, or rewrite the sentence.
- No over-summarizing. Do not recap what you just did at the end of a response. Do not add closing paragraphs restating the changes. The diff speaks for itself.
- Code comments: facts, decisions, and the why only. No narration of what the code does. No multi-line comment blocks explaining obvious logic.
- Git commits: no Co-Authored-By trailers. Plain commit messages only.

## Out of scope for MVP (note as TODOs, don't build)
Themes, keyboard shortcuts, session rename/delete polish, Windows code signing, the multi-session orchestration dashboard. The architecture must not *block* these, but they are not MVP work.

## Definition of done (MVP)
Launch → enter API key (written to Pi's `auth.json`, mode 0600, never shown to the renderer) → real models populate and one is selectable → type a message and watch it stream token-by-token → see tool calls render → past session appears in the sidebar after restart.
