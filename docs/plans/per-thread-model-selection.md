# Plan: Per-thread model selection

Status: implemented (HOY-176, HOY-177, HOY-178)

## Context

The model selector renders in every thread composer but `App.handleSelectModel` (src/App.tsx) calls `set_model(activeSessionId, ...)` against the boot control session, and App passes the same `state?.model` / `selecting` / `onSelectModel` to every `ThreadView`. Threads only inherit model changes at sidecar spawn via Pi's globally persisted `defaultModel`. Target: route `set_model` to the focused thread's own session (deferred until the session exists), track and display the model per thread, surface per-thread errors, and shed the App-level handler.

Decided: a pick on a never-prompted thread is ephemeral (lost on app restart). After the first prompt the session JSONL owns the model; the global `defaultModel` usually matches the pending pick anyway. No workspace.json change.

Decided: the footer's model display is removed. With selection per thread, the composer's selector is the model display; a single footer slot cannot represent it. ContextBar keeps status/ctx/cost only.

## Verified facts (Pi 0.78.0, pinned)

- Pi RPC `set_model` (pi-coding-agent dist/modes/rpc/rpc-mode.js:359-367) validates against `modelRegistry.getAvailable()` (auth-configured models only) and returns the full ModelInfo on success.
- `session.setModel` (dist/core/agent-session.js:1097-1109) throws `No API key for <provider>/<id>` without auth; sets the session model; appends a `model_change` JSONL entry (a session restored from `sessionFile` resumes its model); persists `defaultModel` globally (last pick becomes the default for future spawns); re-clamps thinking level.
- Rust `set_model` already takes `session_id` (src-tauri/src/commands.rs:71-87) and surfaces Pi's error string. No Rust change needed.
- Store (src/state/store.ts): `Thread {id,title,updatedAt,sessionId?,sessionFile?,archived?}`; sessions spawn lazily in `submitPrompt` (~348-435) and `hydrateThread` (~487-514) through `acquireSession` (~558-570, deduped via `pendingSessions`). Per-thread records `turns/streaming/stats/threadErrors` keyed by threadId; `closePanel` drops them and nulls `sessionId`. `persistProjects` serializes an explicit field allowlist, so a new ephemeral Thread field stays unpersisted for free.
- UI: `ModelSelect.current` takes `{provider,id}` and resolves it against `models` (src/components/ModelSelect.tsx:46-58). `Composer` renders ModelSelect from props (src/components/Composer.tsx:125-134). `ThreadView` already reads `turns/streaming/threadErrors` from the store by threadId and passes model props through; established pattern: ThreadView reads store, Composer stays presentational. `ContextBar` shows `state?.model?.id` (control-scoped) while its stats are already per-thread.
- App boot hydrates `store.models` via `refreshProviderData()` and fetches `get_state(controlId)` into local App state, currently the only source of "default model".
- Tests: bun tests in tests/ with the `mock.module("@/lib/ipc", ...)` pattern (tests/refresh.test.ts); store driven directly via `useSessionStore.setState/getState`.

## Store API shape

```ts
// src/lib/types.ts
export interface ModelRef { provider: string; id: string }
interface Thread {
  // ... existing ...
  // Selected model. Set on pick (deferred until a session exists), hydrated
  // from get_state after spawn. Ephemeral: the session JSONL owns it after
  // the first prompt.
  model?: ModelRef | null;
}

// src/state/store.ts -- new state
defaultModel: ModelRef | null;            // Pi's global defaultModel, boot-hydrated
modelSelecting: Record<string, boolean>;  // per-thread selector busy flag

// new actions
setDefaultModel: (model: ModelRef | null) => void;
selectModel: (threadId: string, provider: string, modelId: string) => Promise<void>;
```

`selectModel`: no-op on unknown thread; sets `modelSelecting[threadId]`, clears `threadErrors[threadId]`. Live session: `await setModel(thread.sessionId, ...)`; success patches `thread.model` and `defaultModel` (Pi just persisted it globally); rejection writes `threadErrors[threadId]`, leaves model state untouched. No session (defer-don't-spawn): patch `thread.model` only, no spawn, no `defaultModel` update. `finally` clears `modelSelecting`.

Deferred-apply helper (module-level in store.ts, next to `acquireSession`):

```ts
// Idempotence: submitPrompt and hydrateThread both call this after the deduped
// acquireSession resolves. Session ids are never reused; no cleanup needed.
const modelApplied = new Set<string>();

async function applyThreadModel(threadId: string, sessionId: string) {
  if (modelApplied.has(sessionId)) return;
  modelApplied.add(sessionId);
  // get_state for the session truth; only set_model when the pending pick
  // differs (avoids a redundant model_change JSONL entry per reopen). With no
  // pick, adopt the session's model into thread.model (restore hydration).
  // On set_model failure: revert thread.model to the session truth, rethrow.
}
```

## Steps (one ticket each)

### 1. Store: per-thread model state + selectModel

Files: `src/lib/types.ts`, `src/state/store.ts`, new `tests/modelSelection.test.ts`

- types.ts: add `ModelRef`; add `model?: ModelRef | null` to `Thread`.
- store.ts: `defaultModel: null`, `modelSelecting: {}`, `setDefaultModel`, `selectModel` per the shape above (reuse `patchThread`/`findThread`). `closePanel`: keep `thread.model` (pending picks survive panel close; stale values are re-verified by Step 2 hydration) but drop `modelSelecting[threadId]` with the other per-thread records.
- Tests (mock.module pattern from tests/refresh.test.ts; seed projects via setState): live select calls `setModel` with the THREAD's sessionId and updates `thread.model` + `defaultModel`; deferred select never calls `setModel` and leaves `defaultModel` alone; rejection ("No API key for groq/x") lands in `threadErrors`, model state unchanged.

### 2. Deferred apply at spawn + restore hydration

Files: `src/state/store.ts`, `tests/modelSelection.test.ts`

- Add `applyThreadModel` + `modelApplied` guard.
- `submitPrompt`: after the session id is known (covers both the fresh-spawn and existing-session paths; the guard makes repeat calls free), `await applyThreadModel(threadId, sessionId)` BEFORE `sendPrompt`. A failure rethrows into submitPrompt's existing catch: prompt not sent on a model the user didn't pick, error surfaces in `threadErrors`, `thread.model` reverted so retry-after-fix works.
- `hydrateThread`: after `setThreadSessionIdInternal`, `void applyThreadModel(...).catch(...)` into `threadErrors`; hydration must not block transcript restore.
- Tests (unique session ids per test; the guard Set is module-level): deferred-then-applied (set_model called with the new sessionId before sendPrompt, defaultModel updated); already-matching (get_state returns the pick, so no set_model); restore-hydration (no pick, thread.model adopts get_state truth); mid-prompt apply failure (sendPrompt not called, streaming false, threadErrors set, thread.model reverted).

### 3. UI rewiring: shed App.handleSelectModel, per-panel display, drop the footer model

Files: `src/App.tsx`, `src/components/ThreadView.tsx`, `src/components/Composer.tsx`, `src/components/ContextBar.tsx`, `FOLLOWUPS.md`

- App.tsx: delete `handleSelectModel` and `selecting`; in the boot effect call `setDefaultModel` from the control session's `piState.model`; stop passing `models/currentModel/selecting/onSelectModel` to ThreadView; `<ContextBar />` without the state prop. Keep local `state` for the debug round-trip.
- ThreadView.tsx: add store selectors (`models`, `modelSelecting[threadId]`, `defaultModel`, `selectModel`) per its existing pattern; extend the existing projects useMemo to surface `thread.model`. Pass Composer `currentModel={threadModel ?? defaultModel}`, `onSelectModel={(p, id) => void selectModel(threadId, p, id)}`.
- Composer.tsx: `currentModel` prop becomes `{provider,id} | null`, passed straight to `ModelSelect.current` (drop the ModelInfo conversion). ModelSelect unchanged.
- ContextBar.tsx: remove the model display entirely. Drop the `state` prop (the model was its only use, lines 32 and 115), delete the model span from the right segment, keep status/ctx/cost, update the header comment.
- FOLLOWUPS.md: flip "Per-thread model selection" to resolved pointing at this plan; add a new follow-up: live thread sidecars cache auth.json at spawn and `save_provider_key` respawns only the control session, so a newly saved key is invisible to already-live thread sessions (`set_model` fails "No API key" until panel close/reopen). Options: respawn all live sessions on key save, or a Pi auth-reload RPC when available.

## Edge cases

- Archived threads: archiving closes the panel; no selector reachable. `thread.model` survives and is reconciled on reopen by hydration.
- Pick while a prompt streams (live session): goes straight to the sidecar; Pi applies it to subsequent steps/turns, matching Pi CLI semantics.
- Concurrent pick during the deferred-apply window: worst case two set_model calls; last-writer-wins in Pi; benign.
- Respawn-after-key-save staleness: recorded as a new follow-up (above), out of scope here.
- defaultModel drift: another thread's successful pick updates `defaultModel` optimistically (Pi persisted it); external edits to settings.json reflect only on restart, pre-existing and out of scope.
- First boot, no providers: empty models, null defaultModel; ModelSelect shows its empty/disabled state in the composer (the footer no longer shows a model at all).
- Restored thread whose model's provider key was deleted: spawn succeeds (Pi falls back), hydration adopts whatever get_state returns.

## Verification

1. `bun test` (new tests/modelSelection.test.ts plus existing green); `bunx tsc --noEmit`; `bun run tauri:dev` builds.
2. Live via the Tauri MCP bridge:
   - Boot with two providers keyed: every composer selector shows the boot default; the footer shows no model (status/ctx/cost only).
   - Thread A, no prompt yet: pick model X; no `create_session` / `set_model` captured (defer-don't-spawn); A shows X, B shows default.
   - Prompt A: captured order `create_session`, `get_state`, (`set_model` with A's sessionId only if differing), `send_prompt`.
   - Thread B live: pick Y; `set_model` carries B's sessionId (not s1, not A's); A still shows X.
   - Restart, reopen A from sessionFile: selector shows the transcript's model with no `set_model` fired.
   - Failure: pick a model whose provider key was removed, on a live thread; that panel's error banner shows Pi's "No API key for ...", the selector snaps back, other panels unaffected.
