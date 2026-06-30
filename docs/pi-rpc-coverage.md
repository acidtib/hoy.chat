# Pi RPC coverage

What Hoy uses of pi 0.80.2's RPC surface (`--mode rpc`, JSONL over stdio), against
the full command and event set in
`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`. Snapshot from a
docs-and-source review on 2026-06-30 (bumped 0.78.0 -> 0.80.2); re-check on every
pi version bump.

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

## Commands (8 of 30 used)

| RPC command | What it does | Hoy status | Notes |
|---|---|---|---|
| `prompt` | Send a user message, start a turn | used, gaps planned (HOY-205) | `commands.rs:235`; `images[]` and `streamingBehavior` unused |
| `abort` | Stop the streaming turn | used | `commands.rs:272` |
| `get_state` | Current model, thinking level, streaming flags | used | `commands.rs:42`; `thinking_level` read but never written |
| `get_messages` | Full transcript as AgentMessage objects | used | `commands.rs:183`, restore on thread open |
| `get_available_models` | List models | used | `commands.rs:54`, model selector |
| `get_session_stats` | Tokens, cost, contextUsage, sessionFile | used | `commands.rs:260`; contextUsage fetched, no context meter UI |
| `set_model` | Switch active model | used | `commands.rs:70` |
| `extension_ui_response` | Answer extension dialogs | partial | `sidecar.rs:200`; `select`/`confirm` wired (approval cards), `input`/`editor` auto-cancelled, fire-and-forget methods dropped |
| `steer` | Inject a message mid-turn, after current tool calls | unused | Biggest gap; pi's signature interruption feature |
| `follow_up` | Queue a message for after the turn ends | unused | |
| `set_steering_mode` | Queue delivery: `all` or `one-at-a-time` | unused | |
| `set_follow_up_mode` | Same for follow-ups | unused | |
| `set_thinking_level` | Set thinking: off, minimal, low, medium, high, xhigh | planned (HOY-204) | Composer dropdown exists but is local state only, `Composer.tsx:81` |
| `cycle_thinking_level` | Step through thinking levels | unused | |
| `cycle_model` | Step through scoped models | unused | Deferred with keyboard shortcuts |
| `compact` | Manual compaction, optional custom instructions | unused | Hoy only renders the `compaction_start` status |
| `set_auto_compaction` | Toggle auto-compaction | unused | |
| `set_auto_retry` | Toggle auto-retry on transient errors | unused | `auto_retry_start` status renders |
| `abort_retry` | Cancel a pending retry | unused | |
| `new_session` | Fresh session, optional `parentSession` | unused | Hoy respawns the sidecar per thread instead |
| `switch_session` | Point the running agent at another session file | unused | Same reason |
| `fork` | New session file from a previous entry (by `entryId`) | unused | Session tree/branching feature gap |
| `clone` | Duplicate active branch into a new file | unused | |
| `get_fork_messages` | Messages of a fork point | unused | |
| `get_last_assistant_text` | Last assistant message text | unused | Would back a copy action |
| `set_session_name` | Name/rename the session | unused | Backend for deferred rename polish |
| `export_html` | Export session to static HTML | unused | Cheap win: one call plus a save dialog |
| `bash` | Run a command outside the agent loop (`!` mode) | unused | Output reaches the LLM on the next prompt |
| `abort_bash` | Cancel that command | unused | |
| `get_commands` | List extension/prompt/skill commands | unused | Natural backend for `/` autocomplete in the composer |

## Events (mapped in `map_pi_event`, `sidecar.rs:365`)

| RPC event | Hoy status | Notes |
|---|---|---|
| `message_update` (text_delta) | used | Streams as `Text`, `sidecar.rs:367` |
| `message_update` (thinking_delta) | unused | Explicitly skipped; no reasoning event kind yet (TODO.md) |
| `message_end` | partial | Only `error`/`aborted` stop reasons surface, `sidecar.rs:379` |
| `tool_execution_start/update/end` | used | `Tool` events with phase, `sidecar.rs:393` |
| `agent_end` | used | Terminal `Done` unless `willRetry`, `sidecar.rs:336` |
| `auto_retry_start` | used | `Status` "retrying" |
| `compaction_start` | used | `Status` "compacting"; now also carries `reason` and `willRetry` (0.79.10) and a post-compaction token estimate (0.79.8), unused |
| `compaction_end`, `auto_retry_end` | unused | `compaction_end` now includes the post-compaction token estimate (0.79.8) |
| `agent_start`, `turn_start/end`, `message_start` | unused | |
| `queue_update` | planned (HOY-205) | Backs the queued-message UI for mid-turn sends |
| `extension_error` | unused | |
| `project_trust` | n/a | Extension event only (0.79.0), not in the RPC stream; trust defaults to trusted since the sidecar sets no `projectTrustContextFactory` |
| `extension_ui_request` | partial | `select`/`confirm` become `PermissionRequest`; `input`/`editor` cancelled; `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` dropped, `sidecar.rs:327` |

## Not reachable over RPC

Interactive-only surfaces that would need Hoy-side UI on top of other commands:
model/login selectors, `/settings`, the `/tree` navigator, `/resume` picker,
`/copy`, `/share` (gist), themes, keybindings. SDK-only (our sidecar entry could
expose them, stock RPC does not): `importFromJsonl`, session tree label APIs.
