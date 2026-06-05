# Plan: Pivot the sidecar to our own SDK entry via `runRpcMode` (+ branded dir)

Status: proposed (not yet implemented)

Includes the branded/isolated agent-dir change (`~/.hoy/agent`) as part of this pivot.

## Context

We are pivoting Pi integration from spawning the stock `pi --mode rpc` **binary** to spawning
**our own thin entry** that calls Pi's SDK programmatically. Why: the stock binary gives us no
way to override the system prompt (identity/branding) or inject a custom resource loader. We
still want process-per-session isolation (M3 decision) and we want SDK flexibility
(`systemPromptOverride`, in-process tools later, mid-turn steering).

**Key finding that makes this cheap (verified against installed `pi-coding-agent` 0.78.0):**
Pi exposes its RPC server *programmatically*:

- `runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>` — runs the exact JSONL RPC
  protocol our Rust already speaks (`{type:"response", command, success, data|error}` + streamed
  `AgentSessionEvent`s). (`dist/modes/rpc/rpc-mode.d.ts`)
- `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })` builds that runtime,
  where `factory` is **our** hook to construct the session with a custom `DefaultResourceLoader`
  (`systemPromptOverride`, `appendSystemPromptOverride`, branded `agentDir`).
  (`dist/core/agent-session-runtime.d.ts`, `dist/core/sdk.d.ts`)
- `runRpcMode` handles the **entire** command surface: `prompt`, `steer`, `follow_up`, `abort`,
  `get_state`, `set_model`, `get_available_models`, `get_session_stats`, `set_thinking_level`,
  `new_session`, `switch_session`, `fork`, `get_messages`, `compact`, … (`rpc-types.d.ts`
  `RpcCommand`). So **all of M3 and M4's backend commands come for free** — Rust just sends them.

Consequence: the stock binary *also* runs `runRpcMode` internally; we are only replacing the
default runtime with one that injects our overrides. **The Rust↔sidecar protocol is unchanged**
(`sidecar.rs`, `reader.rs`, `commands.rs` stay as-is). Net new code is a small TS entry + a
build retarget + minor spawn-arg/env edits.

**Two message layers (not the same thing):** ① React↔Rust is **Tauri IPC** (`invoke()` +
`Channel`) — we own and design it (command sigs in `commands.rs`/`ipc.ts`, the `AgentEvent`
shape; streaming uses a Channel per the CLAUDE.md rule). ② Rust↔sidecar is **stdio JSONL** (Pi's
`runRpcMode` protocol) — plain OS pipes, no Tauri involved. "RPC" in the spec = hop ②. This
pivot's quiet upside: by owning the sidecar **entry** we now control *both ends* of hop ②, so its
protocol becomes a choice rather than a constraint. We deliberately keep Pi's `runRpcMode`
protocol on ② (zero Rust churn + full command surface free); owning the entry just leaves the
door open to a custom Rust↔sidecar contract later if we ever need one.

Outcome: Hoy spawns one self-contained sidecar per session, branded (`~/.hoy/agent`, "you are
Hoy" identity), with full Pi capabilities and the same stdio contract we built in M1.

## Verified facts (don't re-derive)
- SDK installed at `sidecar/pi-src/node_modules/@earendil-works/pi-coding-agent` (0.78.0),
  pinned in `sidecar/pi-src/package.json`.
- Current build (`sidecar/build.sh`) does `bun build --compile <pi cli.js> -> pi-<triple>` +
  assembles `pi-payload` (assets pi resolves via `PI_PACKAGE_DIR`). We reuse this machinery.
- Rust spawn (`sidecar.rs::PiProcess::spawn`) sets `PI_PACKAGE_DIR`, `current_dir(cwd)`, args
  `--mode rpc --no-session --offline --no-context-files`, pipes stdio. Resolution via
  `resolve_sidecar_paths()` (env → `sidecar/pi-<triple>` → exe dir). `build.rs` exposes
  `TARGET_TRIPLE`.
- Rust protocol: send `{type, id, ...}`; expect `{type:"response", command, id, success,
  data|error}`; unsolicited events (streaming) routed to a Channel in M3.

## Changes

### 1. New sidecar entry — `sidecar/pi-src/hoy-sidecar.ts`
Lives in `pi-src/` so it resolves the SDK from the local `node_modules`. Skeleton:
```ts
import {
  createAgentSessionRuntime, createAgentSession,
  DefaultResourceLoader, SessionManager, SettingsManager, runRpcMode,
} from "@earendil-works/pi-coding-agent";

const HOY_SYSTEM_PROMPT = `You are Hoy ... Identity: always answer "Hoy".`;
const agentDir = process.env.PI_CODING_AGENT_DIR!;            // branded dir, set by Rust

const factory = async ({ cwd, agentDir, sessionManager }) => {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noContextFiles: true,                                     // replaces the --no-context-files flag
    systemPromptOverride: () => HOY_SYSTEM_PROMPT,            // branding/identity (the whole point)
    appendSystemPromptOverride: (base) => base,              // keep our own ~/.hoy APPEND_SYSTEM if present
  });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager, settingsManager });
  return { ...result, services: /* from createAgentSessionServices */, diagnostics: [] };
};

const runtime = await createAgentSessionRuntime(factory, {
  cwd: process.cwd(), agentDir, sessionManager: SessionManager.inMemory(),  // inMemory = M1/M3; M4 may persist
});
await runRpcMode(runtime);   // never returns; speaks our existing protocol
```
Implementation detail to verify while coding: the exact `CreateAgentSessionRuntimeResult` the
factory must return (`services`) — read `dist/core/agent-session-services.d.ts`
(`createAgentSessionServices` / `createAgentSessionFromServices`). The skeleton above uses the
high-level `createAgentSession`; if it doesn't yield `services`, build via
`createAgentSessionServices` then `createAgentSessionFromServices`.

### 2. `sidecar/build.sh` — retarget the compile
Change `ENTRY` from pi's `dist/bun/cli.js` to our `sidecar/pi-src/hoy-sidecar.ts`; keep the
`bun build --compile -> pi-<triple>` output name and the `pi-payload` assembly + `PI_PACKAGE_DIR`
(the agent loop still reads pi's package.json/assets at runtime). Output stays
`sidecar/pi-<triple>` so `resolve_sidecar_paths()` is untouched.

### 3. `src-tauri/src/sidecar.rs` — spawn args + branded dir env
- Drop the pi-CLI flags (`--mode rpc --no-session --offline --no-context-files`); our entry is
  not the pi CLI and doesn't parse them (behaviors move into the entry: `noContextFiles`,
  `SessionManager.inMemory`). Spawn the binary with no args (or a single `rpc` sentinel if we
  want one entry to support modes later).
- Add `.env("PI_CODING_AGENT_DIR", agent_dir)` (branded dir, resolved once in
  `SidecarManager::new()` via `crate::pi_config::agent_dir()`), alongside the existing
  `PI_PACKAGE_DIR`. Keep `current_dir(cwd)` (per-session project cwd). Thread `agent_dir` through
  `PiProcess::spawn` / `respawn` / the live test (same signature change as the branded-dir plan).
- Protocol code (`request`, `route_message`, `reader.rs`) unchanged.

### 4. Branded dir — `src-tauri/src/pi_config.rs`
- `agent_dir()` default → `~/.hoy/agent`; replace the ambient `PI_CODING_AGENT_DIR` override with
  our own `HOY_AGENT_DIR` (tests/power users). Rust writes `auth.json` there; the sidecar reads
  the same dir via the `PI_CODING_AGENT_DIR` env we set on it. Update comments/tests as in that
  doc. "Fully isolated, no import" stands.

### 5. Docs / guardrails
- **CLAUDE.md** — rewrite the "Do NOT embed Pi in-process" + "Pi runs as `pi --mode rpc`"
  non-negotiables. New decision: Pi still runs as a **separate spawned process over stdio** (not
  embedded in Rust/renderer), but that process is **our own entry calling Pi's SDK
  `runRpcMode`**, not the stock CLI. We do NOT reimplement Pi's agent loop — `runRpcMode` is
  Pi's. Branding via `systemPromptOverride`; branded `~/.hoy/agent`. Also update the auth.json
  path landmine to the branded dir.
- **PI_DESKTOP_SPEC.md** — §1 (agent row: "our SDK entry via runRpcMode" not `pi --mode rpc`),
  §3 (architecture diagram + the streaming note: the sidecar is our entry; protocol identical),
  §0 (agent dir branded), and note M3/M4 backend commands are provided by `runRpcMode`. Record
  the pivot decision + the zosma comparison (we keep process-per-session isolation AND get SDK
  flexibility because Pi exposes `runRpcMode` + an injectable runtime factory).

## Out of scope / defer (note, don't build)
- **Disk extensions / skills discovery** from `~/.hoy/agent` needs `jiti` + `typebox` resolvable
  in the compiled sidecar (zosma's #151/#152 trap). The branded dir starts empty (fully isolated),
  so there's nothing to load yet — defer extension discovery; verify the `bun build --compile`
  bundles or externalizes jiti/typebox before enabling it.
- **In-process custom tools** (zosma's office-docs pattern via `customTools`/`extensionFactories`)
  — possible now that we own the entry, but not part of this pivot.
- **OAuth identity edge:** for Claude Pro/Max OAuth, Anthropic validates `system[0]="You are
  Claude Code…"`; `systemPromptOverride` affects the discovered prompt (system[1]+), so add a
  short identity-note paragraph like zosma rather than removing system[0]. Verify before relying
  on a full rebrand for OAuth users.
- Mid-turn **steer/follow_up** is now available from `runRpcMode`; wiring it into the composer is
  a later UI task, not this pivot.

## Risks / watch-items
- **Compiled-entry boot:** re-run the M0 round-trip — `bun build --compile` our entry, then send
  `{type:"get_state"}` and confirm a `response`. The asset-resolution gotchas M0 hit
  (`PI_PACKAGE_DIR`, package.json) may recur for our entry; keep `pi-payload`.
- **Factory wiring** (`services` in `CreateAgentSessionRuntimeResult`) is the one unverified TS
  contract; confirm against `agent-session-services.d.ts` early.
- Per-session process weight is unchanged (a compiled JS runtime either way); on-disk size is
  comparable to the current binary.

## Verification
1. `bash sidecar/build.sh` produces `sidecar/pi-<triple>`; the throwaway round-trip
   (`sidecar/m0-harness`, or a quick `cargo test ... live_get_state_round_trip` after wiring)
   gets a `get_state` response from our entry.
2. `cargo build` + `cargo test` in `src-tauri/` pass (signature change threaded through;
   `pi_config` agent_dir test added).
3. `bun run tauri:dev`: enter a key in Settings → written to **`~/.hoy/agent/auth.json`** (0600),
   `~/.pi` untouched. Models populate (`get_available_models` via our entry). Select one.
4. Send a prompt → tokens stream into the panel (unsolicited `AgentSessionEvent`s over the M3
   Channel). Ask "who are you?" → answers **Hoy** (proves `systemPromptOverride`). `get_session_stats`
   populates the context bar.
5. Through the MCP bridge, `provider_statuses` → `configured:true, source:"authFile"` (Rust and
   the sidecar agree on the branded dir).
