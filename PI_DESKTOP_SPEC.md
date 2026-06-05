# Hoy Desktop — Build Spec (Claude Code Handoff)

> A native desktop GUI for the **Pi coding agent** (`@earendil-works/pi-coding-agent`).
> Tauri shell + webview UI + Pi running as a spawned sidecar over its RPC (JSONL-over-stdio) protocol.
> App identifier `dev.hoy-desktop.app`. ("Pi" in this doc always means the agent, never the app.)
> This is the same three-layer architecture OpenAI's Codex desktop app uses (Chromium renderer → Node/Rust main → spawned agent process). We are deliberately copying it. The spawned process is our own thin SDK entry running Pi's `runRpcMode`, not the stock CLI (see §0).
>
> **Status:** M0–M4 shipped. The UI was redesigned into a Zed-style multi-panel workspace (§2). Two decisions now baked in: **session per thread** (each thread drives its own Pi sidecar) and **panels are the canonical MVP layout**. M3 streams real Pi responses into each panel over a Tauri Channel, concurrently across panels, with the context bar fed by `get_session_stats`. M4 persists transcripts (Pi `SessionManager` in the branded dir) and the projects/threads tree (`workspace.json`), restores them on relaunch, kills a thread's sidecar on panel close, and adds an archive + Zed-style history view (archive -> history -> unarchive/delete).

---

## 0. Read this first (context for the agent doing the work)

- **Do not embed Pi in-process.** Pi is a Node library/CLI; our backend is Rust. The agent runs as a **separate process** we spawn and talk to over stdin/stdout. This is intentional and matches shipping products (Codex, Hermes desktop). It is also what makes future multi-agent orchestration clean (process-per-agent).
- **The sidecar is our own SDK entry, not the stock `pi` CLI (pivot decision).** We spawn `sidecar/pi-src/hoy-sidecar.ts` (bun-compiled to `pi-<triple>`), which builds a runtime via `createAgentSessionServices` + `createAgentSessionFromServices` and runs Pi's `runRpcMode`. We do this to brand the agent (identity via `appendSystemPromptOverride`) and to inject a custom resource loader (and, later, in-process tools / mid-turn steering), which the stock binary gives no hook for. We still do NOT reimplement Pi's agent loop: `runRpcMode` is Pi's and serves the entire RPC command surface, so all M3/M4 backend commands (`prompt`, `set_model`, `get_available_models`, `steer`, `follow_up`, `fork`, `compact`, ...) come for free, Rust just sends them. The Rust↔sidecar JSONL protocol is byte-for-byte unchanged from M1. Versus zosma's approach: we keep process-per-session isolation AND gain SDK flexibility, because Pi exposes `runRpcMode` plus an injectable runtime factory. Branding must go through `appendSystemPromptOverride`; a `systemPromptOverride` (Pi's `customPrompt`) REPLACES the default coding prompt and strips tool guidelines (verified in 0.78.0 `core/system-prompt.js`).
- **Branded, isolated agent dir.** Hoy uses `~/.hoy/agent` (override `HOY_AGENT_DIR`), never `~/.pi`, so it never touches a user's stock pi install. Rust writes `auth.json` there; `sidecar.rs` passes the same path to the sidecar as `PI_CODING_AGENT_DIR`, which the SDK entry honors. The dir starts empty (fully isolated), so disk extension/skill discovery is deferred (needs jiti/typebox resolvable in the compiled binary).
- **The end goal is orchestration** (many agent sessions, user in the "orchestrator seat"). The MVP already runs **a sidecar per thread** (decided): each UI thread maps 1:1 to a Pi session, keyed by `sessionId` in the `SidecarManager` from day one. M5 adds the orchestrator dashboard on top; the process model is in place from M3. Never reintroduce a single-session assumption.
- **Streaming is non-negotiable.** Tokens must appear as they generate. Use a **Tauri `Channel`**, NOT the `emit`/`listen` event system — Tauri's docs are explicit that the event system is not for high-throughput streaming and channels are the recommended mechanism.
- **Pi RPC framing gotcha:** Pi's protocol is strict JSONL delimited by `\n` ONLY. Do not use a line reader that also splits on Unicode separators U+2028/U+2029 — those are valid inside JSON strings and will corrupt messages. In Rust, split on `\n` yourself and strip a trailing `\r`.
- **Verify the Pi API as you go.** Pin an exact version of `@earendil-works/pi-coding-agent`. The RPC command/event names below are from the docs but confirm against the installed version's `--help` and docs before relying on edge cases.

---

## 1. Tech stack (decided — do not re-litigate)

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Tauri v2** | Rust core, small binary, OS webview |
| Frontend | **React + TypeScript + Vite** | Standard Tauri frontend |
| Package manager / bundler | **Bun** | For the frontend only; not where the agent runs |
| Agent | **Pi SDK** via our `runRpcMode` entry | Spawned sidecar (`hoy-sidecar.ts`), JSONL over stdio, not the stock CLI |
| Streaming transport | **Tauri Channel** | Rust → webview token deltas |
| Frontend→Rust | **`invoke()` commands** | `@tauri-apps/api/core` |
| Component library | **shadcn/ui** + **AI Elements** (`elements.ai-sdk.dev`) | AI Elements is a shadcn-based registry of AI-app blocks. See the critical caveat below. |
| Markdown / code rendering | **Streamdown** + fine-grained **Shiki** | Inside the AI Elements `code-block`. Shiki is pinned to a fine-grained bundle (json/typescript/diff langs, one-light/one-dark-pro themes on the JS regex engine) to avoid the per-language chunk explosion + oniguruma wasm. Streamdown needs `@source "../node_modules/streamdown/dist"` in the Tailwind CSS so its utility classes are generated. |
| Styling | Tailwind v4 (shadcn's default) | Match the reference UX below |

### UI components: shadcn/ui + AI Elements

Use **shadcn/ui** as the component foundation and pull AI-specific blocks from the **AI Elements** registry (`https://elements.ai-sdk.dev`). AI Elements is built on shadcn conventions, so the project's shadcn theme applies to them automatically — they are not a separate design system.

Blocks that map directly to our UI (install from the registry rather than hand-building):
- **Conversation** + **Message** → the transcript (M3)
- **Prompt Input** → the composer (M3)
- **Tool** → collapsible tool-call rows (M4)
- **Model Selector** → top-bar model picker (M2)
- **Context** → the bottom context-window bar (see §2 and below)
- (Later / orchestration) **Reasoning**, **Task**, **Queue**, **Chain of Thought**

> **⚠️ CRITICAL CAVEAT — do NOT adopt the Vercel AI SDK.**
> AI Elements is designed to integrate with Vercel's **AI SDK** (`useChat`, its streaming hooks, its message types). **We are not using the AI SDK.** Our tokens stream from Pi over the Tauri `Channel` as our own `AgentEvent` type (spec §6). Therefore:
> - Use AI Elements components as **presentational shadcn components**, driven by **our** state/event stream.
> - Do **not** `npm install ai` / `@ai-sdk/*`, and do not wire components to `useChat` or any AI-SDK transport. That would reintroduce an in-process agent data layer — the exact thing this architecture rejects (Pi runs as a spawned sidecar; the agent loop lives in Pi, not in the frontend).
> - If a given block only exists as an AI-SDK transport wrapper with no presentational value, skip it and compose the equivalent from base shadcn.
> - Adapter pattern: write a thin mapper from `AgentEvent` → the props each AI Elements block expects, in `lib/`. Keep the AI-SDK assumption quarantined there if any leaks in.
> - **Quarantine location (as built):** the AI-SDK prop-shape types the blocks expect are redefined locally in `src/lib/ai-elements-types.ts` (`MessageRole`, `ToolState`, `ToolUIPart`, `FileUIPart`) so nothing imports from `ai`. Verified: no `ai` / `@ai-sdk/*` in `package.json`.

---

## 2. Target UX (MVP) — Zed-style multi-panel workspace

The canonical layout is a tiled workspace (Zed agent-panel inspired), **not** a single
transcript with a top bar. Threads open as resizable panels side by side; each panel is a
self-contained agent conversation with its own composer.

```
┌───────────────┬──────────────────────┬──────────────────────┐
│  PROJECTS     │  ✦ thread A      + ⤢ ⋯ ✕ │  ✦ thread B   + ⤢ ⋯ ✕ │
│  [search... ] │  ───────────────────── │  ───────────────────── │
│ ▾ hoy         │   user: ...            │   user: ...            │
│   ✦ thread A  │   reasoning ▸          │   assistant (stream)█  │
│   ✦ thread B  │   ▸ read  src/x.ts     │    ▸ bash  ls -la  ✓   │
│   + new       │   assistant: ...(strm)█ │                        │
│ ▸ jiji        │  ───────────────────── │  ───────────────────── │
│               │  │ message...  [model▾]│  │ message...  [model▾]│ │
│               │  │  + @  Agent▾ High▾ ▷│  │  + @  Agent▾ High▾ ▷│ │
├───────────────┴──────────────────────┴──────────────────────┤
│ ⟨ ctx 32k / 200k · 16%   ·   $0.12   ·   sonnet · idle  (focused thread) │
└─────────────────────────────────────────────────────────────┘
```

Layout (as built):
- **Left sidebar:** **projects → threads**, not a flat session list. Collapsible project
  groups, a thread search box, and a per-project "New thread". Resizable right edge. Render
  the list even with one thread (multi-thread is a data change, not a redesign). Active and
  open threads are marked.
- **No top bar.** The **model selector lives inside each thread's composer** (per-thread
  scope), next to an **Agent/Plan** mode pill and a **thinking-level** pill. **Settings is a
  full page** (`SettingsPage`), reached from the thread menu / home page — not a top-bar gear
  or modal.
- **Body = tiled thread panels.** Each panel renders a `ThreadView` (header with title +
  new-thread/expand/menu/close, the conversation, and a docked composer flush to the panel
  bottom). Panels are keyed by **thread id**. Sizing invariants live in `src/state/store.ts`:
  the first panel fills the body; opening another splits/borrows width down to
  `PANEL_MIN_WIDTH`; closing or removing re-flows survivors into the freed space; dragging a
  divider borrows from the neighbor, then scrolls the strip once the neighbor hits the
  minimum. Helpers: `placeNewPanel`, `shrinkPanels`, `growPanels`, `fitPanels`,
  `resizePanelEdge`.
- **Conversation format:** flat document style (not chat bubbles). User turns are bordered
  muted blocks; assistant content streams inline; reasoning is a collapsible block; tool
  calls split by kind (read/search = bare muted rows, edit/terminal = bordered cards with a
  diff or command+output) per the Zed reference. Driven by AI Elements blocks
  (`Conversation`, `Message`, `Reasoning`, `Tool`, `CodeBlock`).
- **Composer:** textarea + Send; **disabled for that panel while its turn streams**,
  re-enabled on `done`. Each panel streams independently (session per thread, §3).
- **Home page:** a "What's up next?" empty state shows when no panels are open.
- **Bottom context bar (thin):** a one-line strip (`ContextBar`) showing **context-window
  usage** (`tokens / contextWindow · percent%`) plus session cost + current model + agent
  status, for the **focused** thread. Backed by Pi's `get_session_stats` RPC, which returns a
  `contextUsage` object (`tokens`, `contextWindow`, `percent`) plus token totals and `cost`.
  Use the AI Elements **Context** block. Poll `get_session_stats` after each `done` (and on
  focus change); `contextUsage` fields may be `null` right after compaction until the next
  assistant response — render "—" rather than crashing. (Currently renders placeholders;
  wired in M3.)

Defer: themes, keyboard shortcuts, thread rename/delete polish, persistence UI. Note them as TODOs.

---

## 3. Architecture

```
 React webview (renderer)
   │  invoke('send_prompt', { sessionId, message, onEvent: Channel })
   │  invoke('list_models'), invoke('set_model'), invoke('get_state'), invoke('save_provider_key')
   ▼
 Rust core (Tauri main)
   │  owns a SidecarManager: HashMap<SessionId, PiProcess>
   │  each PiProcess: child handle + stdin writer + stdout reader task
   │  reader task parses JSONL events → forwards over the per-request Channel
   ▼
 hoy-sidecar (our SDK entry running Pi's runRpcMode; spawned, one per session)
```

### Thread / Project / Session mapping
- The UI's `Thread` maps 1:1 to a Pi **session** (a spawned `hoy-sidecar` running Pi's
  `runRpcMode`) once one exists. `Thread.sessionId` is `null` until the thread first spawns its session.
- A `Project` maps to a working directory (`Project.path`). A thread's session is spawned
  with its project's cwd so Pi operates in the right repo.
- Sidecar state stays keyed by `sessionId` in `SidecarManager` (`HashMap<SessionId, PiProcess>`).
  This was always the design; **session per thread** (decided) just means we now create more
  than one at runtime instead of a single MVP session.

### Process model
- One `hoy-sidecar` child **per thread/session**. A boot **control session** (`s1`) exists
  for model enumeration and pre-thread config; each thread lazily spawns its own session on
  first prompt (in the project's cwd) and stores its id as `Thread.sessionId`. Panels stream
  independently against their own children.
- On `send_prompt`: write `{"type":"prompt","message":...,"id":<reqId>}` + `\n` to that child's stdin.
- A long-lived reader task per child reads stdout lines, parses JSON, and routes events to whatever Channel is currently active for that session (the panel's prompt Channel). Unsolicited events were dropped through M1/M2; M3 forwards them.
- Map Pi events → frontend events:
  - `message_update` w/ `assistantMessageEvent.type === "text_delta"` → `{kind:"text", delta}`
  - `tool_execution_start|update|end` → `{kind:"tool", ...}`
  - `agent_end` → `{kind:"done"}`
  - `auto_retry_*`, `compaction_*` → optional `{kind:"status", ...}`
  - errors → `{kind:"error", message}`

### Provider / key handling
Decision (M2, revised): drive Pi's own credential store rather than build a parallel one. Verified against pi-coding-agent 0.78.0:
- Pi's RPC has **no** auth/login/set-key command. The full command set is `get_state, prompt, get_available_models, set_model, new_session, switch_session, fork, clone, steer, abort, get_session_stats, set_thinking_level, cycle_model, export_html, ...`. Credentials must exist before the sidecar can use them.
- Pi resolves a provider key by priority: runtime `--api-key` > `auth.json` `api_key` entry > `auth.json` OAuth (auto-refreshed) > `<PROVIDER>_API_KEY` env var > `models.json` fallback. So writing `auth.json` is authoritative.
- `auth.json` schema (`core/auth-storage.d.ts`): `Record<provider, {type:"api_key", key} | {type:"oauth", ...tokens}>`. Hoy resolves it to its **branded dir**: `HOY_AGENT_DIR` if set, else `~/.hoy/agent/auth.json` (see `pi_config::agent_dir`). The sidecar reads the same file because `sidecar.rs` exports that path as `PI_CODING_AGENT_DIR` (Pi's `getAgentDir()` env), so both ends agree without touching `~/.pi`.

Implementation: `pi_config.rs` does read-modify-write of `auth.json`, writing only `{type:"api_key"}` entries and preserving any `oauth` entries; writes atomically at mode 0600. `save_provider_key` / `remove_provider_key` then respawn the active sidecar so it reloads (Pi caches auth in memory at startup). The renderer sends a key down once and never reads it back; `provider_statuses` returns configured/not-configured (`ProviderAuth`) only. The earlier keychain/Stronghold + env-injection plan was dropped: Pi already owns this store and there is no RPC to hand it a key. Tradeoff: the key sits in plaintext-0600 on disk, the same as Pi's own CLI, Codex, and Claude Code on Linux.

The provider list (24 entries) and the env-var name mapping (e.g. `google → GEMINI_API_KEY`, not `GOOGLE_API_KEY`) are pinned to Pi **0.78.0** in `pi_config.rs`; re-verify on version bumps.

### Renderer IPC exposure (security)
`withGlobalTauri` is **`false`** in the base `tauri.conf.json` (it is pure attack surface in release: it would hand any renderer JS the full Tauri IPC API, including `save_provider_key`). The dev-only MCP automation bridge needs `window.__TAURI__`, so `src-tauri/tauri.dev.conf.json` re-enables it for dev and `bun run tauri:dev` merges that overlay (RFC 7396). Plain `tauri dev` and release builds keep it off. The bridge itself is gated to `#[cfg(debug_assertions)]`.

---

## 4. Repo layout

```
hoy/
├── src/                         # React frontend (Bun + Vite)
│   ├── main.tsx
│   ├── App.tsx                  # orchestrates the panel strip + sidebar + context bar
│   ├── components/
│   │   ├── Sidebar.tsx          # projects → threads, search, resizable edge
│   │   ├── ThreadView.tsx       # panel: header + conversation + docked composer
│   │   ├── Composer.tsx         # textarea + model selector + Agent/Plan + thinking pills
│   │   ├── ModelSelect.tsx      # model dropdown (AI Elements model-selector)
│   │   ├── ContextBar.tsx       # thin bottom bar: ctx window %, cost, model, status
│   │   ├── SettingsPage.tsx     # full-page provider + API key form (not a modal)
│   │   ├── HomePage.tsx         # "What's up next?" empty state
│   │   └── ai-elements/         # vendored shadcn AI blocks, driven by OUR state:
│   │       ├── conversation.tsx · message.tsx · reasoning.tsx
│   │       ├── tool.tsx · code-block.tsx · model-selector.tsx · shimmer.tsx
│   ├── lib/
│   │   ├── ipc.ts               # typed wrappers around invoke()
│   │   ├── types.ts             # shared event/message types (mirror Rust)
│   │   ├── ai-elements-types.ts # AI-SDK prop-shape quarantine (no `ai` import)
│   │   ├── mock-conversation.ts # seed transcript (M3 replaces with live data)
│   │   ├── useGlobalDrag.ts     # shared resize-drag lifecycle hook
│   │   └── utils.ts
│   └── state/
│       └── store.ts             # zustand: projects, panels, threads, models, providers, auth
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs               # builder, command registration, dev MCP bridge
│   │   ├── sidecar.rs           # SidecarManager, PiProcess, spawn(cwd) + stdin/reader
│   │   ├── reader.rs            # JsonlFramer (\n-only framing) + unit tests
│   │   ├── commands.rs          # #[tauri::command] fns
│   │   ├── pi_config.rs         # read/write Pi's auth.json (api_key entries)
│   │   └── events.rs            # AgentEvent / PiState / ModelInfo serde types
│   ├── build.rs                 # exposes TARGET_TRIPLE for sidecar path resolution
│   ├── tauri.conf.json          # withGlobalTauri:false; externalBin TODO (see below)
│   ├── tauri.dev.conf.json      # dev overlay: withGlobalTauri:true for the MCP bridge
│   └── Cargo.toml
├── sidecar/                     # scripts + payload to produce the pi binary per platform
│   ├── build.sh · pi-<target-triple> · pi-payload/
│   └── README.md
├── package.json
└── README.md
```

> Sidecar resolution (as built): the binary + `PI_PACKAGE_DIR` payload are found via
> `PI_SIDECAR_BIN` / `PI_SIDECAR_PAYLOAD` env overrides, then the dev `sidecar/pi-<triple>` +
> `pi-payload` paths, then next to the executable. `bundle.externalBin` is **not** wired yet —
> `resolve_sidecar_paths()` carries a `TODO(M4/release)` to resolve against Tauri's resource
> dir for distribution.

---

## 5. Milestones (each independently demoable + has acceptance criteria)

> Build in order. Do not start a milestone until the previous one's acceptance criteria pass. Commit at each milestone boundary.

### M0 — Sidecar packaging spike (DONE)
As built: a self-contained `pi-<triple>` binary + a `pi-payload` asset dir resolved via
`PI_PACKAGE_DIR`. Resolution is env-override → dev `sidecar/` path → next-to-exe; Tauri's
`bundle.externalBin` is deferred to release prep (TODO in `resolve_sidecar_paths()`).
Post-pivot, `build.sh` compiles **our** entry (`sidecar/pi-src/hoy-sidecar.ts`) instead of Pi's
`dist/bun/cli.js`; output name, `pi-payload`, and `PI_PACKAGE_DIR` are unchanged, so the binary
runs Pi's `runRpcMode` with our branding.

**Why first:** Pi is a Node CLI. Tauri's sidecar wants a self-contained per-platform binary. If this can't be made to work, the whole plan changes — so de-risk it before writing UI.
- Install Pi, get it running in RPC mode from a terminal manually: `pi --mode rpc --no-session`, type a `get_state` command, confirm a JSON response.
- Produce a self-contained binary (try in this order, stop at first that works): `bun build --compile`, then Node SEA, then `pkg`. Name it for Tauri's convention (`pi-<target-triple>`).
- Wire it into `tauri.conf.json` `bundle.externalBin` + grant shell/process permission.
- **Acceptance:** a throwaway Rust command spawns the bundled sidecar, sends `{"type":"get_state"}`, and logs the parsed response. No UI needed.

### M1 — IPC plumbing skeleton (DONE)
As built: `SidecarManager` keyed by `sessionId`, `JsonlFramer` with `\n`-only framing and
U+2028/U+2029 unit tests in `reader.rs`, request/response correlation by id with a 15s
timeout. Unsolicited events are dropped here (forwarded in M3).

- Scaffold Tauri v2 + React + Bun. App boots to an empty shell with the layout from §2 (static, no data).
- Implement `SidecarManager` keyed by `sessionId`; spawn one sidecar on app start.
- Implement the JSONL reader task with correct `\n`-only framing (see §0 gotcha). Unit-test the framing against a string containing U+2028 inside a JSON string value.
- **Acceptance:** clicking a debug button round-trips `get_state` from the live sidecar and shows it in the UI.

### M2 — Provider configuration (DONE)
As built: writes Pi's `auth.json` directly (the keychain/Stronghold + env-injection plan was
dropped, §3). Settings is a **full page**, not a modal. 8 commands wired (`get_state`,
`active_session_id`, `list_models`, `set_model`, `save_provider_key`, `remove_provider_key`,
`provider_statuses`, `supported_providers`).

- Settings page: choose provider, paste API key.
- Write key into Pi's `auth.json` via `pi_config.rs` (§3), preserving `oauth` entries, atomic at 0600. Respawn the sidecar so it reloads. Never expose the key value to the renderer.
- `list_models` command → calls Pi `get_available_models` → populate the top-bar model selector. `set_model` on selection.
- **Acceptance:** user enters a valid key, the model dropdown populates with real models, selecting one calls `set_model` successfully. Key is not present in any plaintext file or renderer state.

### M3 — Streaming chat, session per thread (the core MVP win) (DONE)
Outcome: prompting from a thread panel streams a real Pi response into that panel, and
multiple panels stream concurrently against their own sidecars.

As built: `PiProcess` carries an active-prompt sink (`Arc<Mutex<Option<Channel<AgentEvent>>>>`);
`route_message`/`map_pi_event` map Pi's raw RPC events to `AgentEvent` (text_delta -> text,
tool_execution_* -> tool with result text flattened, message_end error/aborted -> error,
agent_end -> done unless `willRetry`, auto_retry/compaction -> status) and forward over the
sink, detaching on the terminal done. `create_session(cwd)` spawns a thread's own sidecar in
its project dir (the boot `s1` stays the control session for `list_models`); `send_prompt`
attaches the Channel and returns on preflight; `get_session_stats` and `abort` added. The
prompt/abort responses carry no `data`, so they use `check_success`, not `unwrap_response`.
Frontend: per-thread `turns`/`streaming`/`stats` live in the zustand store, fed by the
`AgentEvent -> turn` mapper in `lib/turns.ts`; the composer is disabled per panel while its
turn streams; the context bar renders the focused thread's `contextUsage`/cost. Thinking
deltas are dropped for now (AgentEvent has no reasoning kind yet); see FOLLOWUPS.

**Backend**
- **Event forwarding.** Give `PiProcess` an active-prompt sink
  (`Arc<Mutex<Option<Channel<AgentEvent>>>>`). Rewrite `sidecar.rs::route_message` (which
  currently drops unsolicited events) to map Pi events → `AgentEvent` and send over the sink:
  `message_update`/`text_delta` → `text`; `tool_execution_start|update|end` → `tool`;
  `agent_end` → `done`; `auto_retry_*`/`compaction_*` → `status`; errors → `error`. Drop the
  `#[allow(dead_code)]` on `AgentEvent` once it is constructed.
- **Session per thread.** Make the sidecar cwd per-session (today `SidecarManager.cwd` is a
  single `temp_dir()`). Add `create_session(cwd) -> sessionId` to spawn a thread's sidecar in
  its project dir. Keep the boot `s1` as a control/probe session for model enumeration.
- **`send_prompt(sessionId, message, onEvent: Channel<AgentEvent>)`** — attach the channel to
  that session's `PiProcess`, send Pi `{type:"prompt", message, id}`, stream until `agent_end`,
  detach.
- **`get_session_stats(sessionId) -> SessionStats`** and **`abort(sessionId)`**. Add the
  `SessionStats` serde struct to `events.rs` and mirror it in `types.ts`.

**Frontend**
- **Per-thread message store.** Move the transcript model out of `mock-conversation.ts` into
  the zustand store keyed by threadId (the turn shape `ThreadView` already renders). Write a
  thin **`AgentEvent → turn` mapper in `lib/`** that appends text deltas and opens/updates/
  closes tool rows. The AI Elements blocks are already built and mock-driven, so this is
  mostly data wiring.
- **Composer send.** Wire `Composer.onSubmit`: ensure the thread has a session (lazy
  `create_session(project.path)`, store `Thread.sessionId`), open a `Channel`, call
  `send_prompt`. Disable that panel's composer while streaming; re-enable on `done`. Each
  panel owns its own channel/turn-stream.
- **Context bar.** After each `done` for the focused thread, call `get_session_stats` and
  render `tokens / contextWindow · percent%` + cost + model + status via the AI Elements
  Context block; render "—" on null `contextUsage`.
- Add typed `ipc.ts` wrappers for `send_prompt` (Channel arg), `create_session`,
  `get_session_stats`, `abort`.
- Handle `error` and `status` (retry/compaction) gracefully — a small status line, never
  crash the turn.
- **Acceptance:** open two thread panels, type "write a haiku about pipes" in each, watch
  tokens stream into **each** panel independently in real time; the sending panel's composer
  disables then re-enables on done; the bottom bar shows the focused thread's context usage +
  cost after its turn.

### M4 — Thread/session persistence (DONE)
The collapsible tool rows (read/search rows, edit/terminal cards) are already built in
`ThreadView` and wired to live `tool` events in M3, so M4 is persistence + lifecycle.

As built (two layers, cleanly split):
- **Pi owns transcripts.** The sidecar entry now runs `SessionManager.open(HOY_SESSION_FILE)`
  when Rust passes a thread's file, else `SessionManager.create(cwd)` (fresh), falling back to
  fresh if the file is missing. `create(cwd)` resolves the session dir under
  `PI_CODING_AGENT_DIR`, so transcripts live in the branded dir
  (`~/.hoy/agent/sessions/<encoded-cwd>/`). Verified: `getAgentDir()` (config.js) reads that env;
  `createAgentSession` (sdk.js) seeds `agent.state.messages` from the opened session, so
  `get_messages` returns the prior transcript and follow-ups append to the same file.
- **Hoy owns the workspace tree.** `workspace.rs` does atomic read-modify-write of
  `~/.hoy/agent/workspace.json` (projects -> threads, each thread carrying its durable
  `sessionFile`, title, updatedAt, archived). Commands `load_workspace` / `save_workspace`; the
  store loads on boot and autosaves (debounced) on change. The live sidecar `sessionId` is
  ephemeral and not persisted; `sessionFile` is the durable identity.
- **Lifecycle (decided):** closing a panel **kills** its sidecar (`close_session` ->
  `SidecarManager::remove` -> child Drop) and clears the cached turns; reopening re-spawns and
  reloads from disk. New backend commands: `create_session(cwd, sessionFile?)`, `close_session`,
  `get_messages`, `delete_session_file` (guarded to the sessions dir). `SessionStats` gained
  `sessionFile` so the post-turn stats call captures a new thread's path.
- **Archive, not delete (Zed-inspired).** The thread menu archives; archived threads leave the
  projects tree and appear in a flat, searchable **history view** (`ThreadHistory`, toggled from
  the bottom-bar clock), grouped Today / Yesterday / This Week / Older with `project · reltime`.
  An archive toggle flips to archived threads, where each can be unarchived or permanently
  deleted (teardown + drop from workspace + delete the JSONL). The mock seed (`mock-conversation.ts`)
  is retired; first run starts empty.
- Restored and streamed transcripts render identically: `messagesToTurns` merges Pi's
  per-step assistant messages + toolResults between user messages into one assistant turn.
- **Acceptance (verified end to end via the Tauri MCP bridge):** a prompt that triggers a tool
  ("list the files here") shows a tool row with output in the project cwd; restarting the app
  shows the prior thread in the sidebar and reopening it reloads the transcript; archive moves it
  to the history view; delete removes it and its JSONL; closing a panel exits the child (no leak).

### M5 (post-MVP, document only) — Orchestration dashboard
- The process model (a sidecar per thread, concurrent streaming) is already delivered in M3.
  M5 is the **orchestrator view**: live per-thread status, a multi-session dashboard/overview,
  cross-thread coordination. **Do not build now** — confirm M0–M4 didn't close the door
  (manager is keyed by sessionId and threads already map 1:1 to sessions, so it hasn't).

---

## 6. Key contracts (define these explicitly so frontend & backend agree)

**Frontend-facing streaming event (Rust `events.rs` ↔ TS `types.ts`):**
```ts
type AgentEvent =
  | { kind: "text";   delta: string }
  | { kind: "tool";   phase: "start" | "update" | "end";
      toolCallId: string; toolName: string; args?: unknown;
      output?: string; isError?: boolean }
  | { kind: "status"; label: string }      // thinking / retrying / compacting
  | { kind: "error";  message: string }
  | { kind: "done" };
```

**Session stats (for the bottom context bar):**
```ts
type SessionStats = {
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
};
// contextUsage (and its tokens/percent) can be null right after compaction — render "—" until the next assistant response.
```

**Commands (TS signatures via `invoke`):**
```ts
// M0-M2 (wired)
get_state(sessionId: string): Promise<PiState>
active_session_id(): Promise<string | null>
list_models(): Promise<ModelInfo[]>
set_model(sessionId: string, provider: string, modelId: string): Promise<void>
save_provider_key(provider: string, key: string): Promise<void>   // -> writes Pi's auth.json (mode 0600)
remove_provider_key(provider: string): Promise<void>
provider_statuses(providers: string[]): Promise<ProviderAuth[]>
supported_providers(): Promise<ProviderInfo[]>

// M3 (this milestone)
create_session(cwd: string): Promise<string /* sessionId */>     // spawn a thread's sidecar in its project dir
send_prompt(sessionId: string, message: string, onEvent: Channel<AgentEvent>): Promise<void>
get_session_stats(sessionId: string): Promise<SessionStats>      // -> Pi get_session_stats; powers the bottom context bar
abort(sessionId: string): Promise<void>

// M4 (persistence)
list_sessions(): Promise<SessionMeta[]>
switch_session(sessionId: string): Promise<void>
```

The TS wrappers in `ipc.ts` map a UI thread to its `Thread.sessionId` before calling the
session-keyed commands. `AgentEvent` is mirrored in `events.rs` + `types.ts` and is
**constructed** as of M3 (no longer dead code); `SessionStats` (below) must land as a real
type on both sides too.

Map each command to the corresponding Pi RPC command (`get_state`, `get_available_models`, `set_model`, `prompt`, `get_session_stats`, `abort`, session ops). Confirm exact Pi command names/fields against the installed version (pinned 0.78.0).

---

## 7. Risks / watch-items
- **Sidecar packaging (M0)** — resolved for dev (self-contained `pi-<triple>` + `pi-payload`). Release packaging still open: wire `bundle.externalBin` so the binary resolves against Tauri's resource dir (TODO in `resolve_sidecar_paths()`).
- **Per-thread sidecar proliferation** — session per thread means the process count grows with open threads. Decide a lifecycle (kill on thread delete vs keep a closed panel's session warm) and watch memory; `list_models` still needs the control session present.
- **Pi version drift** — pin exact version (0.78.0); the SDK/RPC surface (esp. session/runtime APIs) and the provider list/env-var mapping are still evolving.
- **Windows code signing** — installers will trip SmartScreen unsigned (Hermes desktop hit this). Out of MVP scope; note for release.
- **Linux webview quirks** — WebKitGTK renders differently than Chromium; test the layout on Linux if targeting it.
- **JSONL framing** — covered in §0; write the unit test.

---

## 8. Definition of done (MVP)
A user can: launch the app → open settings and enter an API key (written to Pi's `auth.json`, mode 0600, never shown to the renderer) → see real models populate and pick one in a thread's composer → type a message and watch the response stream into the thread panel token-by-token → open a second thread panel and stream it concurrently → see tool calls the agent makes → and (M4) find their past thread in the sidebar after a restart.
