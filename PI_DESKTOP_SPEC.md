# Pi Desktop — Build Spec (Claude Code Handoff)

> A native desktop GUI for the **Pi coding agent** (`@earendil-works/pi-coding-agent`).
> Tauri shell + webview UI + Pi running as a spawned sidecar over its RPC (JSONL-over-stdio) protocol.
> This is the same three-layer architecture OpenAI's Codex desktop app uses (Chromium renderer → Node/Rust main → spawned agent CLI). We are deliberately copying it.

---

## 0. Read this first (context for the agent doing the work)

- **Do not embed Pi in-process.** Pi is a Node library/CLI; our backend is Rust. The agent runs as a **separate process** we spawn and talk to over stdin/stdout. This is intentional and matches shipping products (Codex, Hermes desktop). It is also what makes future multi-agent orchestration clean (process-per-agent).
- **The end goal is orchestration** (many agent sessions, user in the "orchestrator seat"). The MVP is a single-session chat, but **do not make architectural choices that block multi-session later.** Specifically: key all sidecar state by a `sessionId` from day one, even when there's only one.
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
| Agent | **Pi** via `pi --mode rpc` | Spawned sidecar, JSONL over stdio |
| Streaming transport | **Tauri Channel** | Rust → webview token deltas |
| Frontend→Rust | **`invoke()` commands** | `@tauri-apps/api/core` |
| Component library | **shadcn/ui** + **AI Elements** (`elements.ai-sdk.dev`) | AI Elements is a shadcn-based registry of AI-app blocks. See the critical caveat below. |
| Styling | Tailwind (shadcn's default) | Match the reference UX below |

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

---

## 2. Target UX (MVP)

Mirror the now-standard agent-app layout seen in Codex / Claude Code desktop:

```
┌───────────────┬──────────────────────────────────────┐
│  SESSIONS     │  [model selector ▼]      [settings ⚙] │
│  ───────────  │  ──────────────────────────────────── │
│ ▸ Session 1   │                                        │
│   Session 2   │   transcript (streaming bubbles)       │
│   + New       │   ┌────────────────────────────────┐  │
│               │   │ user: ...                      │  │
│               │   │ assistant: ...(streaming)█     │  │
│               │   │  ▸ tool: bash  ls -la  ✓        │  │
│               │   └────────────────────────────────┘  │
│               │  ──────────────────────────────────── │
│               │  [ type a message...        ] [Send]   │
├───────────────┴──────────────────────────────────────┤
│ ctx 32k / 200k · 16%   ·   $0.12   ·   sonnet · idle   │  ← thin status bar
└───────────────────────────────────────────────────────┘
```

MVP scope of the layout:
- **Left sidebar:** list of sessions + "New session". For MVP a single session is fine, but render it as a list so multi-session is a data change, not a redesign.
- **Top bar:** model selector (populated from Pi), settings/gear (provider + API key config).
- **Transcript:** user + assistant bubbles; assistant streams token-by-token; tool calls render as collapsible inline rows showing tool name + args + success/error.
- **Composer:** text input + Send; disabled while a turn is streaming; re-enabled on `agent_end`.
- **Status:** small indicator when the agent is "thinking"/streaming/running a tool.
- **Bottom context bar (thin):** a one-line strip across the bottom (Hermes-desktop style) showing **context-window usage** (`tokens / contextWindow · percent%`), and optionally session cost + current model + agent status. Backed by Pi's `get_session_stats` RPC command, which returns a `contextUsage` object (`tokens`, `contextWindow`, `percent`) plus token totals and `cost`. Use the AI Elements **Context** block for the usage portion. Poll `get_session_stats` after each `agent_end` (and on session switch); `contextUsage` fields may be `null` right after compaction until the next assistant response — handle that (render "—" rather than crashing).

Defer: themes, keyboard shortcuts, session rename/delete polish, persistence UI. Note them as TODOs.

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
 pi --mode rpc   (spawned sidecar, one per session)
```

### Process model
- One `pi --mode rpc` child **per session**. MVP spawns exactly one but the manager is keyed by `sessionId`.
- On `send_prompt`: write `{"type":"prompt","message":...,"id":<reqId>}` + `\n` to that child's stdin.
- A long-lived reader task per child reads stdout lines, parses JSON, and routes events to whatever Channel is currently active for that session (and/or a broadcast for transcript state).
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
- `auth.json` schema (`core/auth-storage.d.ts`): `Record<provider, {type:"api_key", key} | {type:"oauth", ...tokens}>`. Path resolves via `getAgentDir()`: `PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/auth.json`.

Implementation: `pi_config.rs` does read-modify-write of `auth.json`, writing only `{type:"api_key"}` entries and preserving any `oauth` entries; writes atomically at mode 0600. `save_provider_key` / `remove_provider_key` then respawn the active sidecar so it reloads (Pi caches auth in memory at startup). The renderer sends a key down once and never reads it back; `provider_statuses` returns configured/not-configured (`ProviderAuth`) only. The earlier keychain/Stronghold + env-injection plan was dropped: Pi already owns this store and there is no RPC to hand it a key. Tradeoff: the key sits in plaintext-0600 on disk, the same as Pi's own CLI, Codex, and Claude Code on Linux.

---

## 4. Repo layout

```
pi-desktop/
├── src/                         # React frontend (Bun + Vite)
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx          # session list + new session
│   │   ├── TopBar.tsx           # model selector + settings
│   │   ├── Transcript.tsx       # message list + streaming
│   │   ├── MessageBubble.tsx
│   │   ├── ToolCallRow.tsx      # collapsible tool exec display
│   │   ├── Composer.tsx
│   │   ├── ContextBar.tsx       # thin bottom bar: ctx window %, cost, model, status
│   │   └── SettingsModal.tsx    # provider + API key form
│   ├── lib/
│   │   ├── ipc.ts               # typed wrappers around invoke()
│   │   └── types.ts             # shared event/message types (mirror Rust)
│   └── state/                   # session/message store (zustand or context)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs               # builder, command registration
│   │   ├── sidecar.rs           # SidecarManager, PiProcess, spawn + stdin
│   │   ├── reader.rs            # JSONL reader (\n-only framing) + event mapping
│   │   ├── commands.rs          # #[tauri::command] fns
│   │   ├── pi_config.rs         # read/write Pi's auth.json (api_key entries)
│   │   └── events.rs            # serde types for frontend-facing events
│   ├── tauri.conf.json          # externalBin (pi sidecar), permissions
│   └── Cargo.toml
├── sidecar/                     # scripts to produce the pi binary per platform
│   └── README.md
├── package.json
└── README.md
```

---

## 5. Milestones (each independently demoable + has acceptance criteria)

> Build in order. Do not start a milestone until the previous one's acceptance criteria pass. Commit at each milestone boundary.

### M0 — Sidecar packaging spike (DO THIS FIRST — highest risk)
**Why first:** Pi is a Node CLI. Tauri's sidecar wants a self-contained per-platform binary. If this can't be made to work, the whole plan changes — so de-risk it before writing UI.
- Install Pi, get it running in RPC mode from a terminal manually: `pi --mode rpc --no-session`, type a `get_state` command, confirm a JSON response.
- Produce a self-contained binary (try in this order, stop at first that works): `bun build --compile`, then Node SEA, then `pkg`. Name it for Tauri's convention (`pi-<target-triple>`).
- Wire it into `tauri.conf.json` `bundle.externalBin` + grant shell/process permission.
- **Acceptance:** a throwaway Rust command spawns the bundled sidecar, sends `{"type":"get_state"}`, and logs the parsed response. No UI needed.

### M1 — IPC plumbing skeleton
- Scaffold Tauri v2 + React + Bun. App boots to an empty shell with the layout from §2 (static, no data).
- Implement `SidecarManager` keyed by `sessionId`; spawn one sidecar on app start.
- Implement the JSONL reader task with correct `\n`-only framing (see §0 gotcha). Unit-test the framing against a string containing U+2028 inside a JSON string value.
- **Acceptance:** clicking a debug button round-trips `get_state` from the live sidecar and shows it in the UI.

### M2 — Provider configuration
- Settings modal: choose provider, paste API key.
- Write key into Pi's `auth.json` via `pi_config.rs` (§3), preserving `oauth` entries, atomic at 0600. Respawn the sidecar so it reloads. Never expose the key value to the renderer.
- `list_models` command → calls Pi `get_available_models` → populate the top-bar model selector. `set_model` on selection.
- **Acceptance:** user enters a valid key, the model dropdown populates with real models, selecting one calls `set_model` successfully. Key is not present in any plaintext file or renderer state.

### M3 — Streaming chat (the core MVP win)
- `send_prompt(sessionId, message, onEvent: Channel)` command.
- Composer sends; transcript appends a user bubble + an empty assistant bubble.
- Channel delivers `text_delta`s → assistant bubble grows live. `agent_end` → mark turn complete, re-enable composer.
- Handle `error` and `auto_retry_*` gracefully (show a small status line, don't crash the turn).
- Add the **bottom context bar** (`ContextBar.tsx`): after each `agent_end`, call `get_session_stats` and render context-window usage (`tokens / contextWindow · percent%`) + cost + current model + status, using the AI Elements **Context** block. Handle null `contextUsage` (render "—").
- **Acceptance:** type "write a haiku about pipes", watch tokens stream into the bubble in real time, composer re-enables when done, and the bottom bar updates with context usage and cost after the turn.

### M4 — Tool-call visibility + session persistence
- Render `tool_execution_start/update/end` as collapsible `ToolCallRow`s inside the assistant turn (name, args, streaming output, ✓/✗).
- Drop `--no-session` so Pi persists sessions; on app start, list existing sessions in the sidebar (Pi session listing / `SessionManager`).
- "New session" spawns/targets a fresh session. Switching sessions swaps the transcript.
- **Acceptance:** a prompt that triggers a tool (e.g. "list the files here") shows a tool row with output; restarting the app shows the prior session in the sidebar and its transcript loads.

### M5 (post-MVP, document only) — Orchestration
- Multiple concurrent sessions, each its own sidecar process; sidebar shows live status per session; a dashboard/overview. **Do not build now** — just confirm M0–M4 didn't close the door on it (manager is already keyed by sessionId, so it shouldn't have).

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
get_state(sessionId: string): Promise<PiState>
list_models(): Promise<ModelInfo[]>
set_model(sessionId: string, provider: string, modelId: string): Promise<void>
save_provider_key(provider: string, key: string): Promise<void>   // -> keychain
send_prompt(sessionId: string, message: string, onEvent: Channel<AgentEvent>): Promise<void>
list_sessions(): Promise<SessionMeta[]>
new_session(): Promise<string /* sessionId */>
switch_session(sessionId: string): Promise<void>
get_session_stats(sessionId: string): Promise<SessionStats>  // -> Pi get_session_stats; powers the bottom context bar
abort(sessionId: string): Promise<void>
```

Map each command to the corresponding Pi RPC command (`get_state`, `get_available_models`, `set_model`, `prompt`, session ops). Confirm exact Pi command names/fields against the installed version.

---

## 7. Risks / watch-items
- **Sidecar packaging (M0)** — the single biggest risk. If no bundler produces a working self-contained Pi binary, fallback options: ship Node alongside and invoke `node pi.js`, or bundle Pi's source and a minimal Node runtime. Decide in M0, not later.
- **Pi version drift** — pin exact version; the SDK/RPC surface (esp. session/runtime APIs) is still evolving.
- **Windows code signing** — installers will trip SmartScreen unsigned (Hermes desktop hit this). Out of MVP scope; note for release.
- **Linux webview quirks** — WebKitGTK renders differently than Chromium; test the layout on Linux if targeting it.
- **JSONL framing** — covered in §0; write the unit test.

---

## 8. Definition of done (MVP)
A user can: launch the app → open settings and enter an API key (written to Pi's `auth.json`, mode 0600, never shown to the renderer) → see real models populate and pick one → type a message and watch the response stream in token-by-token → see tool calls the agent makes → and find their past session in the sidebar after a restart.
