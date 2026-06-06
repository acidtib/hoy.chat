# Pi RPC coverage

What Hoy uses of pi 0.78.0's RPC surface (`--mode rpc`, JSONL over stdio), against
the full command and event set in
`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`. Snapshot from a
docs-and-source review on 2026-06-05; re-check on every pi version bump.

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
| `compaction_start` | used | `Status` "compacting" |
| `compaction_end`, `auto_retry_end` | unused | |
| `agent_start`, `turn_start/end`, `message_start` | unused | |
| `queue_update` | planned (HOY-205) | Backs the queued-message UI for mid-turn sends |
| `extension_error` | unused | |
| `extension_ui_request` | partial | `select`/`confirm` become `PermissionRequest`; `input`/`editor` cancelled; `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` dropped, `sidecar.rs:327` |

## Not reachable over RPC

Interactive-only surfaces that would need Hoy-side UI on top of other commands:
model/login selectors, `/settings`, the `/tree` navigator, `/resume` picker,
`/copy`, `/share` (gist), themes, keybindings. SDK-only (our sidecar entry could
expose them, stock RPC does not): `importFromJsonl`, session tree label APIs.
