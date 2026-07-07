# Pi RPC coverage

What Hoy uses of pi 0.80.3's RPC surface (`--mode rpc`, JSONL over stdio), against
the full command and event set in
`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`. Snapshot from a
docs-and-source review on 2026-06-30 (bumped 0.80.2 -> 0.80.3); re-check on every
pi version bump.

## Bump review: 0.80.2 -> 0.80.3 (HOY-221)

No breaking changes for Hoy. Verified against the installed 0.80.3 source:

- **Two new RPC commands wired: `get_entries` (read session entries) and
  `get_tree` (read a tree snapshot).** These are the read side of the
  session-tree/branching feature gap. Confirmed present in 0.80.3
  `rpc-types.d.ts` (absent from 0.80.2). Landed as a pure read surface this bump:
  Rust commands (`commands.rs`), typed `invoke` wrappers (`lib/ipc.ts`), and TS
  types (`lib/types.ts`) mirroring Pi's `SessionEntry` / `SessionTreeNode`. The
  `/tree` navigator UI (HOY-280) and the `fork`/`clone`/`get_fork_messages` write
  side (HOY-281) are now wired on top of this read surface.
- **Edit-tool promptGuidelines byte-identical** to 0.80.2 (`core/tools/{read,
  edit,write}.js`), so the verbatim block in `hoy-system-prompt.ts` is still
  accurate. Docs-block GitHub tag repointed to `v0.80.3`.
- **Provider list and env-var mapping unchanged.** The 0.80.3 CHANGELOG lists no
  provider additions; `core/provider-display-names.js` matches the 0.80.2 set, so
  `pi_config.rs` needs no change for the bump itself. (HOY-317 subsequently
  reconciled the pre-existing gap: added `ant-ling`, `nvidia`, `zai-coding-cn`,
  fixed the `zai` label to "ZAI Coding Plan (Global)", and corrected
  `moonshotai-cn`'s env var to `MOONSHOT_API_KEY`.)
- **Sidecar imports still resolve.** `createAgentSessionServices`,
  `createAgentSessionFromServices`, `runRpcMode`, and the `resourceLoaderOptions`
  we use still export from the package root; the sidecar build succeeds on 0.80.3.
- **`./rpc-entry` package export** launches Pi directly in RPC mode. Does not
  replace our branded sidecar entry (we still need `systemPromptOverride` plus the
  resource loader via `createAgentSessionServices`), noted so we do not mistake it
  for a drop-in.
- **`session_info_changed` extension event** (session name changes). Extension-only,
  not an RPC stream event, same category as `project_trust` / `n/a`.
- Non-RPC: Claude Sonnet 5 with adaptive thinking; default OpenAI model is now
  `gpt-5.5`; `ExecutionEnvExecOptions` renamed to `ShellExecOptions` in the
  agent-core public harness (SDK type, we do not import it).

## Bump review: 0.78.0 -> 0.80.2

No breaking changes for Hoy. Verified against the installed 0.80.2 source:

- **RPC command surface unchanged.** Same 30 commands; the request union in
  `rpc-types.d.ts` is identical to 0.78.0.
- **auth.json format unchanged.** API key entries are still `{type:"api_key", key}`
  (`core/auth-storage.d.ts`). 0.80.2 only realigned pi-ai's in-memory
  `ApiKeyCredential` to that existing discriminator (`api-key` -> `api_key`);
  `pi_config.rs` already writes `api_key`, so no change.
- **Sidecar imports still resolve.** `createAgentSessionServices`,
  `createAgentSessionFromServices`, `createAgentSessionRuntime`, `runRpcMode`,
  `SessionManager`, `CreateAgentSessionRuntimeFactory` are all still exported, as
  are the `resourceLoaderOptions` we use (`systemPromptOverride`, `noContextFiles`,
  `extensionFactories`). The 0.80.0 pi-ai entrypoint move (root -> `/compat`) does
  not touch us: we import from the `@earendil-works/pi-coding-agent` root.
- **Edit-tool promptGuidelines byte-identical** to 0.78.0, so the verbatim block
  in `hoy-system-prompt.ts` is still accurate.
- **New `project_trust` is extension-only, not an RPC stream event** (defined in
  `core/extensions/types.d.ts`, absent from `dist/modes/rpc/`). Trust defaults to
  trusted because our sidecar passes no `projectTrustContextFactory`
  (`SettingsManager.projectTrusted` defaults `true`), so `map_pi_event` needs no
  change. If we ever want to gate project-local resources, the runtime option
  `projectTrustContextFactory` and the global `defaultProjectTrust` setting exist.

Non-RPC deltas worth tracking (not part of the RPC surface, noted for future work):
auth.json API-key entries can now carry `env` overrides (0.79.5);
`CONFIG_DIR_NAME` is now exported (0.79.7), relevant to the `.pi` project-dir TODO;
RPC extension UI request/response types are now exported (0.79.0) and could
replace the hand-typed shapes in `sidecar.rs`; late tool progress callbacks after
settlement are now dropped instead of emitting stale `tool_execution_update`
(0.79.2), which helps the HOY-199 duplicate-block handling.

Status key: **used** (wired end to end), **partial** (some of the surface wired),
**planned** (Linear ticket filed), **unused** (never invoked or mapped).

## Commands (10 of 32 used, on pinned 0.80.3)

The 32 rows are the 0.80.3 surface. The last two rows (`get_entries`, `get_tree`)
are the 0.80.3 additions, now wired as a read surface (Rust command + typed IPC
wrapper + types) with no UI yet; the `/tree` navigator that consumes them is a
follow-up.

| RPC command | What it does | Hoy status | Notes |
|---|---|---|---|
| `prompt` | Send a user message, start a turn | used | `commands.rs`; `images[]` sent from the composer (HOY-205); `streamingBehavior` plumbed, exercised by the steering UI (HOY-218) |
| `abort` | Stop the streaming turn | used | `commands.rs:272` |
| `get_state` | Current model, thinking level, streaming flags | used | `commands.rs:42`; `thinking_level` read but never written |
| `get_messages` | Full transcript as AgentMessage objects | used | `commands.rs:183`, restore on thread open |
| `get_available_models` | List models | used | `commands.rs:54`, model selector |
| `get_session_stats` | Tokens, cost, contextUsage, sessionFile | used | `commands.rs:260`; contextUsage fetched, no context meter UI |
| `set_model` | Switch active model | used | `commands.rs:70` |
| `extension_ui_response` | Answer extension dialogs | used | `select`/`confirm`/`input`/`editor` all wired (approval + text cards); `input`/`editor` answer with `{value}` like select |
| `steer` | Inject a message mid-turn, after current tool calls | covered (HOY-218) | Driven via `prompt` + `streamingBehavior:"steer"` (same `_queueSteer` path); the standalone command is not invoked to avoid a duplicate code path |
| `follow_up` | Queue a message for after the turn ends | covered (HOY-218) | Driven via `prompt` + `streamingBehavior:"followUp"` (same `_queueFollowUp` path); standalone command not invoked |
| `set_steering_mode` | Queue delivery: `all` or `one-at-a-time` | unused | |
| `set_follow_up_mode` | Same for follow-ups | unused | |
| `set_thinking_level` | Set thinking: off, minimal, low, medium, high, xhigh | used (HOY-204) | `commands.rs:90`; composer dropdown drives it via `store.selectThinkingLevel`, re-synced from `get_state` (pi clamps per model) |
| `cycle_thinking_level` | Step through thinking levels | unused | |
| `cycle_model` | Step through scoped models | unused | Deferred with keyboard shortcuts |
| `compact` | Manual compaction, optional custom instructions | used (HOY-229) | "Compact now" popover near the usage meter; reads the CompactionResult from the response (longer request timeout) |
| `set_auto_compaction` | Toggle auto-compaction | used (HOY-229) | MemoryPanel toggle, per active session; synced from `get_state.autoCompactionEnabled` |
| `set_auto_retry` | Toggle auto-retry on transient errors | unused | `auto_retry_start` status renders |
| `abort_retry` | Cancel a pending retry | unused | |
| `new_session` | Fresh session, optional `parentSession` | unused | Hoy respawns the sidecar per thread instead |
| `switch_session` | Point the running agent at another session file | unused | Same reason |
| `fork` | New session file from a previous entry (by `entryId`) | used (HOY-281) | `commands.rs` `fork_session`; typed `forkSession` wrapper -> `{text, cancelled}`. Rebinds the sidecar to the branch; read the new file via `get_session_stats` |
| `clone` | Duplicate active branch into a new file | used (HOY-281) | `commands.rs` `clone_session`; `cloneSession` wrapper -> `{cancelled}` |
| `get_fork_messages` | Messages of a fork point | used (HOY-281) | `commands.rs` `get_fork_messages`; `getForkMessages` wrapper -> `{messages:[{entryId,text}]}` |
| `get_last_assistant_text` | Last assistant message text | unused | Would back a copy action |
| `set_session_name` | Name/rename the session | unused | Backend for deferred rename polish |
| `export_html` | Export session to static HTML | unused | Cheap win: one call plus a save dialog |
| `bash` | Run a command outside the agent loop (`!` mode) | unused | Output reaches the LLM on the next prompt |
| `abort_bash` | Cancel that command | unused | |
| `get_commands` | List extension/prompt/skill commands | used (HOY-223) | `commands.rs`; feeds the composer "/" autocomplete (cached per thread in the store), which inserts "/name " and lets the existing prompt path dispatch. A Hoy "/compact" built-in is added client-side |
| `get_entries` | Read session entries | read surface (HOY-221) | `commands.rs`; typed `getEntries` wrapper; returns `{entries, leafId}`. No UI yet; backs the follow-up `/tree` navigator. Optional `since` for incremental reads |
| `get_tree` | Read session tree snapshot | read surface (HOY-221) | `commands.rs`; typed `getTree` wrapper; returns `{tree, leafId}`. No UI yet; pairs with `get_entries` for the `/tree` navigator |

## Events (mapped in `map_pi_event`, `sidecar.rs:365`)

| RPC event | Hoy status | Notes |
|---|---|---|
| `message_update` (text_delta) | used | Streams as `Text`, `sidecar.rs:367` |
| `message_update` (thinking_start/delta/end) | used (HOY-211) | Maps to `Reasoning` (`sidecar.rs`); folds into the turn's reasoning block, drives the live "Thinking for Ns" timer |
| `message_end` | partial | Only `error`/`aborted` stop reasons surface, `sidecar.rs:379` |
| `tool_execution_start/update/end` | used | `Tool` events with phase, `sidecar.rs:393` |
| `agent_end` | used | Terminal `Done` unless `willRetry`, `sidecar.rs:336` |
| `auto_retry_start` | used | `Status` "retrying" |
| `compaction_start` | used | `Status` "compacting"; now also carries `reason` and `willRetry` (0.79.10) and a post-compaction token estimate (0.79.8), unused |
| `compaction_end` | used (HOY-229) | Maps to `CompactionEnd` (reason, aborted, willRetry, token estimate); auto-path notice + usage refresh over the streaming sink |
| `auto_retry_end` | unused | |
| `agent_start`, `turn_start/end`, `message_start` | unused | |
| `queue_update` | used (HOY-205) | Mapped to the `QueueUpdate` AgentEvent; the queued-message chips consume it (HOY-218) |
| `session_start` | used (HOY-282) | Mapped to `SessionStart` (reason + previousSessionFile) when the sidecar rebinds after fork/clone; the store refreshes stats to repoint `Thread.sessionFile`. Only over the streaming sink (a mid-turn switch); a fork RPC issued while idle has no sink, so the branch action reads the new file via `get_session_stats` instead. The new file path is not in the event |
| `extension_error` | unused | |
| `project_trust` | n/a | Extension event only (0.79.0), not in the RPC stream; trust defaults to trusted since the sidecar sets no `projectTrustContextFactory` |
| `session_info_changed` | n/a | Extension event only (0.80.3), not in the RPC stream; would fire on session name changes |
| `extension_ui_request` | used | all methods routed in `classify_extension_ui` (`sidecar.rs`): `select`/`confirm`/`input`/`editor` -> `PermissionRequest`; `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` -> their own events. Delivered through the per-turn sink, so events with no active prompt are not surfaced (between-turn delivery would need a persistent UI channel) |

## Not reachable over RPC

Interactive-only surfaces that would need Hoy-side UI on top of other commands:
model/login selectors, `/settings`, the `/tree` navigator, `/resume` picker,
`/copy`, `/share` (gist), themes, keybindings. Note: `get_entries` / `get_tree`
(wired this bump, HOY-221) give the `/tree` navigator RPC-readable backing. SDK-only
(our sidecar entry could expose them, stock RPC does not): `importFromJsonl`,
session tree label APIs.
