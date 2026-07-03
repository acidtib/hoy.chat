// Owns the spawned Pi processes. One PiProcess per session, keyed by SessionId
// in the SidecarManager from day one (MVP has one session; orchestration adds
// more without restructuring). We drive Pi's RPC over stdio directly rather
// than via the shell plugin so the JSONL framing (reader.rs) stays under our
// control, per the protocol's LF-only requirement.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use crate::events::{AgentEvent, ToolPhase};
use crate::reader::JsonlFramer;

pub type SessionId = String;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

type EventSink = Arc<Mutex<Option<Channel<AgentEvent>>>>;

// Byte-identical to SPAWN_NOTIFY_PREFIX in hoy-agents.ts. A notify with this
// prefix is a spawn request, consumed here and never shown to the user (HOY-231).
const SPAWN_NOTIFY_PREFIX: &str = "@hoy/spawn-subagent:";

// Outcome of awaiting a correlated response, before it is mapped to the public
// String error in request()/request_with_dialog_grace().
enum RequestError {
    Closed,
    TimedOut,
}

// Await a oneshot response, charging `dead_air_budget` only against time with no
// response AND no outstanding dialog. While `dialog_outstanding()` is true the
// budget is reset each tick, so a slash-command handler blocked on a dialog
// (HOY-215) never trips it, while a genuinely wedged sidecar (no dialog, no
// bytes) still times out after the budget of dead air. `&mut rx` keeps the
// receiver alive across ticks.
async fn await_with_dialog_grace(
    mut rx: oneshot::Receiver<Value>,
    dead_air_budget: Duration,
    tick: Duration,
    dialog_outstanding: impl Fn() -> bool,
) -> Result<Value, RequestError> {
    let mut dead_air = Duration::ZERO;
    loop {
        match tokio::time::timeout(tick, &mut rx).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(_)) => return Err(RequestError::Closed),
            Err(_) => {
                if dialog_outstanding() {
                    dead_air = Duration::ZERO;
                } else {
                    dead_air += tick;
                    if dead_air >= dead_air_budget {
                        return Err(RequestError::TimedOut);
                    }
                }
            }
        }
    }
}

// A single spawned sidecar child (our SDK entry running Pi's runRpcMode) plus
// the machinery to issue request/response RPC commands against it. Unsolicited
// events (no `id`) are mapped to AgentEvent and forwarded to `sink`, the Channel
// of the prompt currently streaming on this session (None between turns).
pub struct PiProcess {
    child: Mutex<Child>,
    // Shared with the reader thread, which auto-cancels unanswerable extension
    // UI dialogs (HOY-186) and must therefore write responses itself.
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    // Ids of extension_ui_request dialogs forwarded to the renderer and not yet
    // answered. The sidecar blocks on each until an extension_ui_response with
    // its id lands on stdin, so teardown paths must cancel these.
    pending_ui: Arc<Mutex<Vec<String>>>,
    next_id: AtomicU64,
    sink: EventSink,
}

impl PiProcess {
    fn spawn(
        bin: &Path,
        payload: &Path,
        agent_dir: &Path,
        cwd: &Path,
        session_file: Option<&str>,
        permission_mode: Option<&str>,
        subagent_type: Option<&str>,
        depth: u32,
        require_subagent_approval: bool,
    ) -> Result<Arc<PiProcess>, String> {
        if agent_dir.as_os_str().is_empty() {
            return Err("agent dir not resolved (set HOME or HOY_AGENT_DIR)".into());
        }
        let mut command = Command::new(bin);
        command
            // No CLI flags: this is our SDK entry (hoy-sidecar.ts), not Pi's CLI.
            // PI_CODING_AGENT_DIR points the entry at our branded dir for
            // auth.json / models.json / settings.json / sessions.
            .env("PI_PACKAGE_DIR", payload)
            .env("PI_CODING_AGENT_DIR", agent_dir)
            .current_dir(cwd);
        // M4: open this thread's existing transcript instead of starting fresh.
        // The entry falls back to a new session if the file is missing.
        if let Some(file) = session_file {
            command.env("HOY_SESSION_FILE", file);
        }
        // HOY-186: the permission extension reads its initial mode from the env,
        // so a respawn restores the thread's mode without a /hoy_mode round trip.
        if let Some(mode) = permission_mode {
            command.env("HOY_PERMISSION_MODE", mode);
        }
        // HOY-231: subagent sessions brand their system prompt via this env var,
        // read by the TS sidecar entry (hoy-sidecar.ts).
        if let Some(t) = subagent_type {
            command.env("HOY_SUBAGENT_TYPE", t);
        }
        // HOY-245: recursion depth for a subagent chain, always set (root
        // sessions are depth 0). Read by the TS sidecar entry to cap recursion.
        command.env("HOY_SUBAGENT_DEPTH", depth.to_string());
        // HOY-248: when the renderer pref requireSubagentApproval is on, the
        // sidecar's `agent` tool raises a per-type consent prompt; off (default)
        // spawns without gating. Always set so a respawn restores the behavior.
        command.env(
            "HOY_REQUIRE_SUBAGENT_APPROVAL",
            if require_subagent_approval { "1" } else { "0" },
        );
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", bin.display()))?;

        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("child has no stdin")?));
        let stdout = child.stdout.take().ok_or("child has no stdout")?;
        let stderr = child.stderr.take().ok_or("child has no stderr")?;

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_ui: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = Arc::new(Mutex::new(None));

        {
            let pending = pending.clone();
            let pending_ui = pending_ui.clone();
            let sink = sink.clone();
            let stdin = stdin.clone();
            thread::spawn(move || {
                let mut framer = JsonlFramer::new();
                let mut reader = BufReader::new(stdout);
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            for record in framer.push(&buf[..n]) {
                                if let Ok(value) = serde_json::from_str::<Value>(&record) {
                                    route_message(&pending, &pending_ui, &sink, &stdin, value);
                                }
                            }
                        }
                    }
                }
                // Stream closed: fail any in-flight requests so callers unblock,
                // and surface the loss to a streaming prompt instead of hanging.
                pending.lock().unwrap().clear();
                pending_ui.lock().unwrap().clear();
                let mut sink = sink.lock().unwrap();
                if let Some(channel) = sink.take() {
                    let _ = channel.send(AgentEvent::Error {
                        message: "sidecar exited mid-stream".into(),
                    });
                    // No agent_end/Done will arrive from a dead child, so emit the
                    // terminal Done ourselves; otherwise the panel's composer stays
                    // disabled forever (the error path deliberately does not stop
                    // streaming, to keep auto-retry turns intact).
                    let _ = channel.send(AgentEvent::Done);
                }
            });
        }

        // Mirror stderr to the parent's stderr so debug logs (e.g. system
        // prompt diagnostics) are visible. Drains line-by-line so the child
        // never blocks on a full pipe.
        thread::spawn(move || {
            use std::io::BufRead;
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[sidecar:stderr] {line}");
            }
        });

        Ok(Arc::new(PiProcess {
            child: Mutex::new(child),
            stdin,
            pending,
            pending_ui,
            next_id: AtomicU64::new(1),
            sink,
        }))
    }

    // Attach the prompt's Channel so the reader thread forwards this session's
    // stream to it. Replaces any previous sink (one prompt streams per session at
    // a time). The reader detaches it on the terminal agent_end.
    pub fn set_sink(&self, channel: Channel<AgentEvent>) {
        *self.sink.lock().unwrap() = Some(channel);
    }

    pub fn clear_sink(&self) {
        *self.sink.lock().unwrap() = None;
    }

    // Assign an `id`, register a pending sender, and write the command line.
    // Callers pass the command body without an `id`. Returns the id and the
    // receiver to await the correlated response on.
    fn send_command(
        &self,
        mut command: Value,
    ) -> Result<(String, oneshot::Receiver<Value>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        command["id"] = json!(id);
        let line = format!(
            "{}\n",
            serde_json::to_string(&command).map_err(|e| e.to_string())?
        );

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        if let Err(e) = self.write_line(&line) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        Ok((id, rx))
    }

    fn map_request_error(&self, id: &str, err: RequestError) -> String {
        match err {
            RequestError::Closed => "sidecar closed before responding".into(),
            RequestError::TimedOut => {
                self.pending.lock().unwrap().remove(id);
                format!("sidecar request timed out after {REQUEST_TIMEOUT:?}")
            }
        }
    }

    // Send an RPC command and await its correlated response. Subject to a flat
    // REQUEST_TIMEOUT; use this for everything except the prompt that may carry
    // a dialog-opening slash command (see request_with_dialog_grace).
    pub async fn request(&self, command: Value) -> Result<Value, String> {
        let (id, rx) = self.send_command(command)?;
        await_with_dialog_grace(rx, REQUEST_TIMEOUT, REQUEST_TIMEOUT, || false)
            .await
            .map_err(|e| self.map_request_error(&id, e))
    }

    // Like request(), but with a caller-chosen dead-air budget. Used for the
    // compact command (HOY-229), whose LLM summarization can run well past the
    // flat REQUEST_TIMEOUT before its response lands.
    pub async fn request_with_timeout(
        &self,
        command: Value,
        budget: Duration,
    ) -> Result<Value, String> {
        let (id, rx) = self.send_command(command)?;
        await_with_dialog_grace(rx, budget, Duration::from_secs(1), || false)
            .await
            .map_err(|e| self.map_request_error(&id, e))
    }

    // HOY-215: a `prompt` can deliver a slash command whose handler blocks
    // synchronously on an extension UI dialog (ctx.ui.input/editor/...), which
    // delays the prompt's preflight response past REQUEST_TIMEOUT. Charge the
    // timeout only against dead air: while a dialog is outstanding the countdown
    // is suspended, so a slow user no longer trips it, but a wedged sidecar with
    // no dialog still times out.
    pub async fn request_with_dialog_grace(&self, command: Value) -> Result<Value, String> {
        let (id, rx) = self.send_command(command)?;
        let pending_ui = self.pending_ui.clone();
        await_with_dialog_grace(rx, REQUEST_TIMEOUT, Duration::from_secs(1), move || {
            !pending_ui.lock().unwrap().is_empty()
        })
        .await
        .map_err(|e| self.map_request_error(&id, e))
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("write to sidecar: {e}"))
    }

    // Answer a pending extension UI dialog (HOY-186). `value` answers select,
    // `confirmed` answers confirm, `cancelled` declines either; the sidecar's
    // blocked tool_call handler resumes on receipt.
    pub fn respond_ui(
        &self,
        request_id: &str,
        value: Option<String>,
        confirmed: Option<bool>,
        cancelled: bool,
    ) -> Result<(), String> {
        self.pending_ui
            .lock()
            .unwrap()
            .retain(|id| id != request_id);
        let mut response = json!({
            "type": "extension_ui_response",
            "id": request_id,
        });
        if cancelled {
            response["cancelled"] = json!(true);
        } else if let Some(confirmed) = confirmed {
            response["confirmed"] = json!(confirmed);
        } else if let Some(value) = value {
            response["value"] = json!(value);
        } else {
            response["cancelled"] = json!(true);
        }
        let line = format!(
            "{}\n",
            serde_json::to_string(&response).map_err(|e| e.to_string())?
        );
        self.write_line(&line)
    }

    // Cancel every pending dialog so the sidecar's blocked tool_call handlers
    // resume (as denials). Called on abort; a killed process needs no answers.
    pub fn cancel_pending_ui(&self) {
        let ids: Vec<String> = self.pending_ui.lock().unwrap().drain(..).collect();
        for id in ids {
            let _ = self.respond_ui(&id, None, None, true);
        }
    }

    // A prompt is streaming on this session (its Channel is attached). Used to
    // skip mid-turn sessions when respawning after a credential change.
    pub fn is_streaming(&self) -> bool {
        self.sink.lock().unwrap().is_some()
    }
}

impl Drop for PiProcess {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn route_message(
    pending: &Mutex<HashMap<String, oneshot::Sender<Value>>>,
    pending_ui: &Mutex<Vec<String>>,
    sink: &EventSink,
    stdin: &Arc<Mutex<ChildStdin>>,
    value: Value,
) {
    let ty = value.get("type").and_then(Value::as_str);

    // Correlated command responses resolve the awaiting request() future.
    if ty == Some("response") {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            if let Some(tx) = pending.lock().unwrap().remove(id) {
                let _ = tx.send(value);
            }
        }
        return;
    }

    // Extension UI sub-protocol (HOY-186). Dialog methods block the sidecar
    // until a response lands on stdin; forward the renderable ones, immediately
    // cancel anything we cannot render so the agent never deadlocks, and drop
    // fire-and-forget methods (notify, setStatus, ...) which expect no answer.
    if ty == Some("extension_ui_request") {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        match classify_extension_ui(id, method, &value) {
            // Blocking dialog: forward to the streaming prompt and track it so
            // teardown can cancel it; cancel now if no prompt is attached so the
            // agent never deadlocks.
            ExtUiOutcome::Dialog(event) => match sink.lock().unwrap().as_ref() {
                Some(channel) => {
                    pending_ui.lock().unwrap().push(id.to_string());
                    let _ = channel.send(event);
                }
                None => {
                    let response =
                        json!({ "type": "extension_ui_response", "id": id, "cancelled": true });
                    if let Ok(text) = serde_json::to_string(&response) {
                        let mut stdin = stdin.lock().unwrap();
                        let _ = stdin
                            .write_all(format!("{text}\n").as_bytes())
                            .and_then(|_| stdin.flush());
                    }
                }
            },
            // Fire-and-forget display method: surface it if a prompt is streaming,
            // else drop it (these expect no response, so dropping is safe).
            ExtUiOutcome::Notify(event) => {
                if let Some(channel) = sink.lock().unwrap().as_ref() {
                    let _ = channel.send(event);
                }
            }
            ExtUiOutcome::Ignore => {}
        }
        return;
    }

    // agent_end terminates a turn unless Pi is about to auto-retry, in which case
    // more events follow and we keep the channel attached.
    if ty == Some("agent_end") {
        let will_retry = value
            .get("willRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut guard = sink.lock().unwrap();
        if will_retry {
            if let Some(channel) = guard.as_ref() {
                let _ = channel.send(AgentEvent::Status {
                    label: "retrying".into(),
                });
            }
        } else if let Some(channel) = guard.take() {
            let _ = channel.send(AgentEvent::Done);
        }
        return;
    }

    if let Some(event) = map_pi_event(ty, &value) {
        if let Some(channel) = sink.lock().unwrap().as_ref() {
            let _ = channel.send(event);
        }
    }
}

// Map an unsolicited Pi RPC event to a frontend AgentEvent, or None to ignore it
// (start/end-of-text markers, thinking deltas, queue updates, ...). agent_end and
// command responses are handled by the caller. Mapping is pinned to Pi 0.78.0's
// AgentSessionEvent + AssistantMessageEvent shapes.
// Outcome of classifying an extension_ui_request. Kept pure (no stdin/sink I/O)
// so route_message stays a thin dispatcher and this is unit-testable.
#[derive(Debug)]
enum ExtUiOutcome {
    // select/confirm/input/editor: awaits an extension_ui_response.
    Dialog(AgentEvent),
    // notify/setStatus/setWidget/setTitle/set_editor_text: no response.
    Notify(AgentEvent),
    // Unknown/unsupported method.
    Ignore,
}

// Map an extension_ui_request to a frontend event. Dialogs become
// PermissionRequest (input/editor carry placeholder/prefill and answer with the
// same {value} shape as select); fire-and-forget methods become their own
// events. Mirrors Pi 0.80.3's RpcExtensionUIRequest union.
fn classify_extension_ui(id: &str, method: &str, value: &Value) -> ExtUiOutcome {
    let str_field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let str_array = |key: &str| {
        value.get(key).and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
    };
    match method {
        "select" | "confirm" => {
            let raw_title = str_field("title").unwrap_or_default();
            // HOY-199: title may embed tool metadata as a JSON prefix:
            // "HOY_TOOL_DATA:{...json...}\n{label}".
            let (tool_call_id, tool_name, tool_args, title) =
                if let Some(rest) = raw_title.strip_prefix("HOY_TOOL_DATA:") {
                    if let Some(nl) = rest.find('\n') {
                        let data_str = &rest[..nl];
                        let clean = rest[nl + 1..].to_string();
                        match serde_json::from_str::<Value>(data_str) {
                            Ok(data) => (
                                data.get("toolCallId")
                                    .and_then(Value::as_str)
                                    .map(String::from),
                                data.get("toolName")
                                    .and_then(Value::as_str)
                                    .map(String::from),
                                data.get("input").cloned(),
                                clean,
                            ),
                            Err(_) => (None, None, None, raw_title),
                        }
                    } else {
                        (None, None, None, raw_title)
                    }
                } else {
                    (None, None, None, raw_title)
                };
            ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
                request_id: id.to_string(),
                method: method.to_string(),
                title,
                message: str_field("message"),
                options: str_array("options"),
                placeholder: None,
                prefill: None,
                tool_call_id,
                tool_name,
                tool_args,
            })
        }
        // Text dialogs: input carries a placeholder hint, editor a seed value.
        // Both answer with {value}, the same shape select uses.
        "input" | "editor" => ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
            request_id: id.to_string(),
            method: method.to_string(),
            title: str_field("title").unwrap_or_default(),
            message: None,
            options: None,
            placeholder: str_field("placeholder"),
            prefill: str_field("prefill"),
            tool_call_id: None,
            tool_name: None,
            tool_args: None,
        }),
        "notify" => {
            let message = str_field("message").unwrap_or_default();
            match message
                .strip_prefix(SPAWN_NOTIFY_PREFIX)
                .and_then(|j| serde_json::from_str::<Value>(j).ok())
            {
                Some(p) => ExtUiOutcome::Notify(AgentEvent::SubagentSpawned {
                    agent_id: p
                        .get("agentId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    subagent_type: p
                        .get("subagentType")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    task: p
                        .get("task")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }),
                None => ExtUiOutcome::Notify(AgentEvent::Notify {
                    message,
                    notify_type: str_field("notifyType"),
                }),
            }
        }
        "setStatus" => ExtUiOutcome::Notify(AgentEvent::SetStatus {
            status_key: str_field("statusKey").unwrap_or_default(),
            status_text: str_field("statusText"),
        }),
        "setWidget" => ExtUiOutcome::Notify(AgentEvent::SetWidget {
            widget_key: str_field("widgetKey").unwrap_or_default(),
            widget_lines: str_array("widgetLines"),
            widget_placement: str_field("widgetPlacement"),
        }),
        "setTitle" => ExtUiOutcome::Notify(AgentEvent::SetTitle {
            title: str_field("title").unwrap_or_default(),
        }),
        "set_editor_text" => ExtUiOutcome::Notify(AgentEvent::SetEditorText {
            text: str_field("text").unwrap_or_default(),
        }),
        _ => ExtUiOutcome::Ignore,
    }
}

fn map_pi_event(ty: Option<&str>, value: &Value) -> Option<AgentEvent> {
    match ty? {
        "message_update" => {
            let inner = value.get("assistantMessageEvent")?;
            // Token deltas live in assistantMessageEvent.delta, NOT .text. Thinking
            // phases map to Reasoning (HOY-211); start/end carry no text.
            match inner.get("type").and_then(Value::as_str) {
                Some("text_delta") => Some(AgentEvent::Text {
                    delta: inner.get("delta").and_then(Value::as_str)?.to_string(),
                }),
                Some("thinking_start") => Some(AgentEvent::Reasoning {
                    delta: None,
                    phase: "start".into(),
                }),
                Some("thinking_delta") => Some(AgentEvent::Reasoning {
                    delta: Some(inner.get("delta").and_then(Value::as_str)?.to_string()),
                    phase: "delta".into(),
                }),
                Some("thinking_end") => Some(AgentEvent::Reasoning {
                    delta: None,
                    phase: "end".into(),
                }),
                _ => None,
            }
        }
        "message_end" => {
            // Surface a failed/aborted turn; agent_end still follows to finalize.
            // Abort is a user action, not a failure: it renders inline on the
            // turn, not as the error banner (HOY-197).
            let message = value.get("message")?;
            match message.get("stopReason").and_then(Value::as_str) {
                Some("aborted") => Some(AgentEvent::Aborted),
                Some("error") => Some(AgentEvent::Error {
                    message: message
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or("the agent stopped unexpectedly")
                        .to_string(),
                }),
                _ => None,
            }
        }
        "tool_execution_start" => Some(AgentEvent::Tool {
            phase: ToolPhase::Start,
            tool_call_id: tool_call_id(value)?,
            tool_name: tool_name(value),
            args: value.get("args").cloned(),
            output: None,
            is_error: None,
        }),
        "tool_execution_update" => Some(AgentEvent::Tool {
            phase: ToolPhase::Update,
            tool_call_id: tool_call_id(value)?,
            tool_name: tool_name(value),
            args: None,
            output: tool_output(value.get("partialResult")),
            is_error: None,
        }),
        "tool_execution_end" => Some(AgentEvent::Tool {
            phase: ToolPhase::End,
            tool_call_id: tool_call_id(value)?,
            tool_name: tool_name(value),
            args: None,
            output: tool_output(value.get("result")),
            is_error: value.get("isError").and_then(Value::as_bool),
        }),
        "auto_retry_start" => Some(AgentEvent::Status {
            label: "retrying".into(),
        }),
        "compaction_start" => Some(AgentEvent::Status {
            label: "compacting".into(),
        }),
        // Auto-path compaction finished (threshold/overflow during a streaming
        // turn, so the sink is attached). The manual path reads the result from
        // the compact command response instead (HOY-229).
        "compaction_end" => {
            let result = value.get("result");
            Some(AgentEvent::CompactionEnd {
                reason: value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                aborted: value
                    .get("aborted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                will_retry: value
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                error_message: value
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tokens_before: result
                    .and_then(|r| r.get("tokensBefore"))
                    .and_then(Value::as_u64),
                estimated_tokens_after: result
                    .and_then(|r| r.get("estimatedTokensAfter"))
                    .and_then(Value::as_u64),
            })
        }
        // The sink is per-active-prompt (set in send_prompt, taken on agent_end),
        // so a queue_update emitted with no active turn is dropped. In practice
        // every queue mutation we care about (enqueue on steer/followUp, dequeue
        // on delivery) happens while a turn is streaming, so the sink is attached.
        "queue_update" => Some(AgentEvent::QueueUpdate {
            steering: string_array(value.get("steering")),
            follow_up: string_array(value.get("followUp")),
        }),
        _ => None,
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn tool_call_id(value: &Value) -> Option<String> {
    value
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn tool_name(value: &Value) -> String {
    value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string()
}

// Pi tool results are { content: [{type:"text", text}], ... }. Flatten the text
// blocks; fall back to a raw string or JSON dump for non-text payloads.
fn tool_output(result: Option<&Value>) -> Option<String> {
    let result = result?;
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        let text: String = items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        // content present but empty (an early streaming update): emit nothing so
        // the row stays clean rather than flashing the wrapper JSON. A later
        // update or the end event carries the real text.
        return (!text.is_empty()).then_some(text);
    }
    if let Some(text) = result.as_str() {
        return Some(text.to_string());
    }
    Some(result.to_string())
}

pub struct SidecarManager {
    sessions: Mutex<HashMap<SessionId, Arc<PiProcess>>>,
    active: Mutex<Option<SessionId>>,
    // Per-session permission mode (HOY-186). The live value lives in the
    // sidecar's extension closure; this mirror feeds HOY_PERMISSION_MODE on
    // respawn so the mode survives the process swap.
    modes: Mutex<HashMap<SessionId, String>>,
    // Per-session spawn cwd (HOY-196), so a respawn rebuilds the session in
    // its own project dir instead of the manager default. The session file is
    // not mirrored here: only pi knows it once a fresh session first writes,
    // so respawn callers capture it live via get_session_stats.
    cwds: Mutex<HashMap<SessionId, PathBuf>>,
    // Per-session subagent type (HOY-231), e.g. "Explore" for a read-only
    // child. Mirrors modes/cwds: without this, respawn (credential/MCP-config
    // changes respawn all idle sessions) would drop HOY_SUBAGENT_TYPE and a
    // restricted child would come back as a full parent session. Only entries
    // for restricted sessions are present; a normal session has none.
    subagent_types: Mutex<HashMap<SessionId, String>>,
    // Per-session recursion depth (HOY-245). Mirrors subagent_types: respawn
    // (credential/MCP-config changes respawn all idle sessions) would otherwise
    // drop HOY_SUBAGENT_DEPTH and a child would come back reporting depth 0.
    // Every session has an entry, root sessions included, since depth is always
    // set (unlike subagent_type, which is optional).
    depths: Mutex<HashMap<SessionId, u32>>,
    // Per-session subagent-approval flag (HOY-248). Mirrors depths so respawn
    // restores HOY_REQUIRE_SUBAGENT_APPROVAL; without it a respawn would drop
    // the gate a user had turned on. Every session has an entry.
    require_approvals: Mutex<HashMap<SessionId, bool>>,
    handle_counter: AtomicUsize,
    bin: PathBuf,
    payload: PathBuf,
    // Branded agent dir (~/.hoy/agent by default), passed to each sidecar as
    // PI_CODING_AGENT_DIR. Resolved once here; the same dir Rust writes auth.json
    // to in pi_config, so Rust and the sidecar agree on credentials.
    agent_dir: PathBuf,
    cwd: PathBuf,
}

impl SidecarManager {
    // No-resolver construction: dev/env paths only (no bundled resource lookup).
    // Used by the live tests; the app uses new_with_resolver from .setup.
    pub fn new() -> Self {
        Self::from_paths(resolve_sidecar_paths(None))
    }

    // App construction: resolves the bundled payload against Tauri's resource dir
    // ($RESOURCE/pi-payload) so a packaged install finds it. Requires an
    // AppHandle, so it runs in .setup, not at .manage time.
    pub fn new_with_resolver<R: tauri::Runtime>(resolver: &tauri::path::PathResolver<R>) -> Self {
        let resource_payload = resolver
            .resolve("pi-payload", tauri::path::BaseDirectory::Resource)
            .ok();
        Self::from_paths(resolve_sidecar_paths(resource_payload))
    }

    fn from_paths((bin, payload): (PathBuf, PathBuf)) -> Self {
        let agent_dir = crate::pi_config::agent_dir().unwrap_or_else(|e| {
            eprintln!("[hoy-desktop] could not resolve agent dir: {e}");
            PathBuf::new()
        });
        Self {
            sessions: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            modes: Mutex::new(HashMap::new()),
            cwds: Mutex::new(HashMap::new()),
            subagent_types: Mutex::new(HashMap::new()),
            depths: Mutex::new(HashMap::new()),
            require_approvals: Mutex::new(HashMap::new()),
            handle_counter: AtomicUsize::new(1),
            bin,
            payload,
            agent_dir,
            cwd: std::env::temp_dir(),
        }
    }

    // Record a session's permission mode for respawn. The caller separately
    // tells the live sidecar via the /hoy_mode extension command.
    pub fn set_mode(&self, id: &str, mode: &str) {
        self.modes
            .lock()
            .unwrap()
            .insert(id.to_string(), mode.to_string());
    }

    fn mode_of(&self, id: &str) -> Option<String> {
        self.modes.lock().unwrap().get(id).cloned()
    }

    fn subagent_type_of(&self, id: &str) -> Option<String> {
        self.subagent_types.lock().unwrap().get(id).cloned()
    }

    fn depth_of(&self, id: &str) -> u32 {
        self.depths.lock().unwrap().get(id).copied().unwrap_or(0)
    }

    fn require_approval_of(&self, id: &str) -> bool {
        self.require_approvals
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(false)
    }

    // Spawn the boot control session in the manager's default cwd. The first
    // session spawned becomes the active one (used for model enumeration).
    pub fn spawn_session(&self) -> Result<SessionId, String> {
        let cwd = self.cwd.clone();
        let id = self.spawn_session_in(&cwd, None, None, None, 0, false)?;
        let mut active = self.active.lock().unwrap();
        if active.is_none() {
            *active = Some(id.clone());
        }
        Ok(id)
    }

    // Spawn a sidecar in `cwd` (a thread's project dir), register it under a fresh
    // SessionId, and return that id. Does not touch the active session: the boot
    // control session stays active for list_models. This is session-per-thread.
    // `session_file` opens an existing transcript (M4 restore); None starts fresh.
    pub fn spawn_session_in(
        &self,
        cwd: &Path,
        session_file: Option<&str>,
        permission_mode: Option<&str>,
        subagent_type: Option<&str>,
        depth: u32,
        require_subagent_approval: bool,
    ) -> Result<SessionId, String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        let proc = PiProcess::spawn(
            &self.bin,
            &self.payload,
            &self.agent_dir,
            cwd,
            session_file,
            permission_mode,
            subagent_type,
            depth,
            require_subagent_approval,
        )?;
        let id = format!("s{}", self.handle_counter.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().unwrap().insert(id.clone(), proc);
        self.cwds
            .lock()
            .unwrap()
            .insert(id.clone(), cwd.to_path_buf());
        if let Some(t) = subagent_type {
            self.subagent_types
                .lock()
                .unwrap()
                .insert(id.clone(), t.to_string());
        }
        self.depths.lock().unwrap().insert(id.clone(), depth);
        self.require_approvals
            .lock()
            .unwrap()
            .insert(id.clone(), require_subagent_approval);
        Ok(id)
    }

    // Build the command for a one-shot OAuth login (HOY_OAUTH_LOGIN). Same
    // binary and branded dir as an RPC sidecar, so login writes the oauth entry
    // into the same auth.json; the entry runs hoy-oauth instead of runRpcMode.
    // stdio is left for the caller to wire (piped in oauth.rs).
    pub fn oauth_login_command(&self, provider: &str) -> Result<Command, String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        if self.agent_dir.as_os_str().is_empty() {
            return Err("agent dir not resolved (set HOME or HOY_AGENT_DIR)".into());
        }
        let mut command = Command::new(&self.bin);
        command
            .env("PI_PACKAGE_DIR", &self.payload)
            .env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("HOY_OAUTH_LOGIN", provider)
            .current_dir(&self.cwd);
        Ok(command)
    }

    // HOY-234: dump the resolved subagent registry via a one-shot sidecar run. Mirrors
    // the OAuth one-shot (a spawn of self.bin with a mode env), but non-interactive:
    // spawn with HOY_LIST_SUBAGENTS=1, capture stdout JSON, exit. cwd selects the
    // project's .hoy/agents.
    pub fn list_subagents(&self, cwd: &Path) -> Result<serde_json::Value, String> {
        if !self.bin.exists() {
            return Err(format!("sidecar binary not found at {}. Run sidecar/build.sh.", self.bin.display()));
        }
        let out = std::process::Command::new(&self.bin)
            .env("PI_PACKAGE_DIR", &self.payload)
            .env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("HOY_LIST_SUBAGENTS", "1")
            .current_dir(cwd)
            .output()
            .map_err(|e| format!("spawn sidecar for list_subagents: {e}"))?;
        if !out.status.success() {
            return Err(format!("list_subagents exited {}: {}", out.status, String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| format!("parse list_subagents output: {e}"))
    }

    // Tear down a session's sidecar (panel close / thread delete). Dropping the
    // Arc runs PiProcess::drop, which kills and reaps the child. The Arc is
    // dropped outside the lock so Drop does not hold it.
    pub fn remove(&self, id: &str) {
        let old = self.sessions.lock().unwrap().remove(id);
        self.modes.lock().unwrap().remove(id);
        self.cwds.lock().unwrap().remove(id);
        self.subagent_types.lock().unwrap().remove(id);
        self.depths.lock().unwrap().remove(id);
        self.require_approvals.lock().unwrap().remove(id);
        drop(old);
    }

    pub fn get(&self, id: &str) -> Result<Arc<PiProcess>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown session: {id}"))
    }

    // HOY-188: true while at least one session is mid-turn (its event sink is
    // attached). The keep-awake supervisor polls this to decide whether to hold a
    // wake lock. Cheap: a mutex lock plus a small map scan.
    pub fn any_streaming(&self) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|p| p.is_streaming())
    }

    // Replace a session's child with a fresh one under the same SessionId. Used
    // after writing auth.json so the running sidecar reloads credentials (Pi
    // caches auth in memory at startup). The session's cwd and permission mode
    // come from the manager mirrors; `session_file` (captured live by the
    // caller via get_session_stats) reopens the transcript so pi-side context
    // survives the swap. Model selection survives because Pi persists
    // defaultModel to settings.json and re-reads it on spawn; a thread pick is
    // reconciled by the renderer. The old Arc is dropped outside the lock so
    // its Drop (kill + wait) does not hold it.
    pub fn respawn(&self, id: &str, session_file: Option<&str>) -> Result<(), String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        let mode = self.mode_of(id);
        let subagent_type = self.subagent_type_of(id);
        let depth = self.depth_of(id);
        let require_subagent_approval = self.require_approval_of(id);
        let cwd = self
            .cwds
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_else(|| self.cwd.clone());
        let proc = PiProcess::spawn(
            &self.bin,
            &self.payload,
            &self.agent_dir,
            &cwd,
            session_file,
            mode.as_deref(),
            subagent_type.as_deref(),
            depth,
            require_subagent_approval,
        )?;
        let old = {
            let mut sessions = self.sessions.lock().unwrap();
            if !sessions.contains_key(id) {
                return Err(format!("unknown session: {id}"));
            }
            sessions.insert(id.to_string(), proc)
        };
        drop(old);
        Ok(())
    }

    // Every live session id with its process, for credential-change respawns.
    pub fn snapshot(&self) -> Vec<(SessionId, Arc<PiProcess>)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, proc)| (id.clone(), proc.clone()))
            .collect()
    }

    pub fn active_session_id(&self) -> Option<SessionId> {
        self.active.lock().unwrap().clone()
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

// Locate the bundled sidecar binary and its PI_PACKAGE_DIR asset payload.
// Order: explicit env overrides, then the dev build under sidecar/, then the
// bundled artifacts of a packaged app. `resource_payload` is the Tauri-resolved
// $RESOURCE/pi-payload (Some only when an AppHandle is available); the binary is
// shipped via externalBin next to the executable with its triple stripped.
fn resolve_sidecar_paths(resource_payload: Option<PathBuf>) -> (PathBuf, PathBuf) {
    let triple = env!("TARGET_TRIPLE");

    let env_bin = std::env::var_os("PI_SIDECAR_BIN").map(PathBuf::from);
    let env_payload = std::env::var_os("PI_SIDECAR_PAYLOAD").map(PathBuf::from);

    // CARGO_MANIFEST_DIR is apps/desktop/src-tauri; the sidecar lives at
    // packages/sidecar off the repo root, three levels up (src-tauri -> desktop
    // -> apps -> root).
    let dev_sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|root| root.join("packages/sidecar"));
    let dev_bin = dev_sidecar
        .as_ref()
        .map(|d| d.join(format!("hoy-pi-{triple}")))
        .filter(|p| p.exists());
    let dev_payload = dev_sidecar
        .as_ref()
        .map(|d| d.join("pi-payload"))
        .filter(|p| p.exists());

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    select_sidecar_paths(
        env_bin,
        env_payload,
        dev_bin,
        dev_payload,
        exe_dir.as_deref(),
        resource_payload,
    )
}

// Pure precedence chain (no filesystem access), split out for unit testing.
// `dev_bin`/`dev_payload` are passed Some only when they exist on disk. The
// bundled binary sits next to the executable as `hoy-pi`(`.exe`): Tauri's
// externalBin strips the target triple build.sh wrote. The bundled payload comes from the
// Tauri resource dir; a final exe-dir join is a legacy fallback.
fn select_sidecar_paths(
    env_bin: Option<PathBuf>,
    env_payload: Option<PathBuf>,
    dev_bin: Option<PathBuf>,
    dev_payload: Option<PathBuf>,
    exe_dir: Option<&Path>,
    resource_payload: Option<PathBuf>,
) -> (PathBuf, PathBuf) {
    let bundled_bin_name = format!("hoy-pi{}", std::env::consts::EXE_SUFFIX);
    let bin = env_bin
        .or(dev_bin)
        .or_else(|| exe_dir.map(|d| d.join(&bundled_bin_name)))
        .unwrap_or_else(|| PathBuf::from(&bundled_bin_name));

    let payload = env_payload
        .or(dev_payload)
        .or(resource_payload)
        .or_else(|| exe_dir.map(|d| d.join("pi-payload")))
        .unwrap_or_else(|| PathBuf::from("pi-payload"));

    (bin, payload)
}

#[cfg(test)]
mod live_tests {
    use super::*;

    // Exercises the exact path the get_state command takes: spawn a sidecar via
    // the manager, then round-trip get_state against the live process. Requires
    // sidecar/hoy-pi-<triple> + pi-payload (run sidecar/build.sh), so it is ignored
    // by default to keep `cargo test` hermetic. Run with:
    //   cargo test --test-threads=1 -- --ignored live_get_state_round_trip
    #[tokio::test]
    #[ignore]
    async fn live_get_state_round_trip() {
        let manager = SidecarManager::new();
        let id = manager.spawn_session().expect("spawn sidecar session");
        let process = manager.get(&id).expect("session present");
        let response = process
            .request(json!({ "type": "get_state" }))
            .await
            .expect("get_state response");

        assert_eq!(response["type"], "response");
        assert_eq!(response["command"], "get_state");
        assert_eq!(response["success"], true);
        assert!(
            response["data"]["sessionId"].as_str().is_some(),
            "expected a sessionId in get_state data, got: {response}"
        );
    }

    // Drives the full M3 streaming path: spawn a sidecar, attach a real Channel
    // (the renderer boundary), send a prompt, and confirm route_message/map_pi_event
    // forward text deltas and a terminal done. Needs the sidecar binary AND a
    // configured credential in ~/.hoy/agent (model from settings.json). Run with:
    //   cargo test live_send_prompt_streams -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_send_prompt_streams() {
        use tauri::ipc::InvokeResponseBody;

        let manager = SidecarManager::new();
        let id = manager.spawn_session().expect("spawn sidecar session");
        let process = manager.get(&id).expect("session present");

        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    sink_events.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        process.set_sink(channel);

        let response = process
            .request(json!({
                "type": "prompt",
                "message": "Write a haiku about pipes. Output only the haiku."
            }))
            .await
            .expect("prompt accepted");
        assert_eq!(response["success"], true, "preflight failed: {response}");

        let mut done = false;
        for _ in 0..120 {
            if events.lock().unwrap().iter().any(|e| e["kind"] == "done") {
                done = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        let collected = events.lock().unwrap().clone();
        let kinds: Vec<&str> = collected
            .iter()
            .filter_map(|e| e["kind"].as_str())
            .collect();
        let text: String = collected
            .iter()
            .filter(|e| e["kind"] == "text")
            .filter_map(|e| e["delta"].as_str())
            .collect();
        eprintln!("event kinds: {kinds:?}");
        eprintln!("streamed text:\n{text}");

        assert!(done, "no done event; kinds={kinds:?}");
        assert!(
            collected.iter().filter(|e| e["kind"] == "text").count() >= 1,
            "no text deltas; kinds={kinds:?}"
        );
        assert!(!text.trim().is_empty(), "assistant produced empty text");
    }

    // Probes the tool-call mapping: a prompt that forces a bash tool, confirming
    // tool_execution_start -> end map to Tool events with extracted output. Same
    // prerequisites as live_send_prompt_streams. Run with:
    //   cargo test live_send_prompt_tool -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_send_prompt_tool() {
        use tauri::ipc::InvokeResponseBody;

        let manager = SidecarManager::new();
        let id = manager.spawn_session().expect("spawn sidecar session");
        let process = manager.get(&id).expect("session present");

        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    sink_events.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        process.set_sink(channel);

        let response = process
            .request(json!({
                "type": "prompt",
                "message": "Run the shell command: echo hoy-tool-probe. Then stop."
            }))
            .await
            .expect("prompt accepted");
        assert_eq!(response["success"], true, "preflight failed: {response}");

        for _ in 0..120 {
            if events.lock().unwrap().iter().any(|e| e["kind"] == "done") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        let collected = events.lock().unwrap().clone();
        let kinds: Vec<&str> = collected
            .iter()
            .filter_map(|e| e["kind"].as_str())
            .collect();
        eprintln!("event kinds: {kinds:?}");
        let tools: Vec<&Value> = collected.iter().filter(|e| e["kind"] == "tool").collect();
        for t in &tools {
            eprintln!(
                "tool phase={} name={} output={:?}",
                t["phase"], t["toolName"], t["output"]
            );
        }

        assert!(
            tools.iter().any(|t| t["phase"] == "start"),
            "no tool start event; kinds={kinds:?}"
        );
        assert!(
            tools.iter().any(|t| t["phase"] == "end"
                && t["output"]
                    .as_str()
                    .is_some_and(|o| o.contains("hoy-tool-probe"))),
            "no tool end carrying the command output; kinds={kinds:?}"
        );
    }

    // Proves the M4 persist -> restore mechanic end to end: prompt a fresh
    // session, capture its sessionFile from stats, tear it down, then spawn a new
    // sidecar opening that file and confirm get_messages returns the prior turn.
    // Same prerequisites as the streaming tests (a configured credential). Run:
    //   cargo test live_persist_and_restore -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_persist_and_restore() {
        use tauri::ipc::InvokeResponseBody;

        let manager = SidecarManager::new();
        let cwd = std::env::temp_dir();

        // 1. Fresh session: prompt and wait for the turn to complete.
        let id = manager
            .spawn_session_in(&cwd, None, None, None, 0, false)
            .expect("spawn fresh session");
        let process = manager.get(&id).expect("session present");
        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    sink_events.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        process.set_sink(channel);
        process
            .request(json!({
                "type": "prompt",
                "message": "Reply with the single word PERSISTED."
            }))
            .await
            .expect("prompt accepted");
        for _ in 0..120 {
            if events.lock().unwrap().iter().any(|e| e["kind"] == "done") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Capture the durable session file Pi wrote.
        let stats = process
            .request(json!({ "type": "get_session_stats" }))
            .await
            .expect("get_session_stats");
        let session_file = stats["data"]["sessionFile"]
            .as_str()
            .expect("stats carry a sessionFile")
            .to_string();
        assert!(!session_file.is_empty());
        eprintln!("session file: {session_file}");

        // 2. Tear down the first sidecar, then reopen the same file in a new one.
        manager.remove(&id);
        let id2 = manager
            .spawn_session_in(&cwd, Some(&session_file), None, None, 0, false)
            .expect("spawn restoring session");
        let restored = manager.get(&id2).expect("restored session present");
        let response = restored
            .request(json!({ "type": "get_messages" }))
            .await
            .expect("get_messages");
        let messages = response["data"]["messages"]
            .as_array()
            .expect("messages array");
        let roles: Vec<&str> = messages.iter().filter_map(|m| m["role"].as_str()).collect();
        eprintln!("restored roles: {roles:?}");

        assert!(
            roles.contains(&"user"),
            "restored transcript missing the user message: {roles:?}"
        );
        assert!(
            roles.contains(&"assistant"),
            "restored transcript missing the assistant reply: {roles:?}"
        );
    }

    // HOY-197: a user-stopped turn maps to Aborted (rendered inline), not Error
    // (the thread-level failure banner). Hermetic: map_pi_event is pure.
    #[test]
    fn message_end_aborted_maps_to_aborted() {
        let value = json!({ "message": { "stopReason": "aborted" } });
        let event = map_pi_event(Some("message_end"), &value);
        assert!(matches!(event, Some(AgentEvent::Aborted)), "got {event:?}");
    }

    #[test]
    fn message_end_error_maps_to_error_with_message() {
        let value = json!({ "message": { "stopReason": "error", "errorMessage": "boom" } });
        match map_pi_event(Some("message_end"), &value) {
            Some(AgentEvent::Error { message }) => assert_eq!(message, "boom"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn message_update_maps_thinking_phases() {
        let start = json!({ "assistantMessageEvent": { "type": "thinking_start" } });
        assert!(matches!(
            map_pi_event(Some("message_update"), &start),
            Some(AgentEvent::Reasoning { delta: None, phase }) if phase == "start"
        ));
        let delta =
            json!({ "assistantMessageEvent": { "type": "thinking_delta", "delta": "hmm" } });
        assert!(matches!(
            map_pi_event(Some("message_update"), &delta),
            Some(AgentEvent::Reasoning { delta: Some(d), phase }) if d == "hmm" && phase == "delta"
        ));
        let end = json!({ "assistantMessageEvent": { "type": "thinking_end" } });
        assert!(matches!(
            map_pi_event(Some("message_update"), &end),
            Some(AgentEvent::Reasoning { delta: None, phase }) if phase == "end"
        ));
    }

    #[test]
    fn message_update_maps_text_delta() {
        let v = json!({ "assistantMessageEvent": { "type": "text_delta", "delta": "hi" } });
        assert!(matches!(
            map_pi_event(Some("message_update"), &v),
            Some(AgentEvent::Text { delta }) if delta == "hi"
        ));
    }

    #[test]
    fn compaction_end_maps_result_and_flags() {
        let v = json!({
            "reason": "threshold",
            "aborted": false,
            "willRetry": false,
            "result": { "tokensBefore": 1000, "estimatedTokensAfter": 200 }
        });
        match map_pi_event(Some("compaction_end"), &v) {
            Some(AgentEvent::CompactionEnd {
                reason,
                tokens_before,
                estimated_tokens_after,
                aborted,
                ..
            }) => {
                assert_eq!(reason, "threshold");
                assert_eq!(tokens_before, Some(1000));
                assert_eq!(estimated_tokens_after, Some(200));
                assert!(!aborted);
            }
            other => panic!("expected CompactionEnd, got {other:?}"),
        }
    }

    #[test]
    fn compaction_end_error_variant() {
        let v = json!({ "reason": "overflow", "aborted": true, "willRetry": true, "errorMessage": "boom" });
        match map_pi_event(Some("compaction_end"), &v) {
            Some(AgentEvent::CompactionEnd {
                aborted,
                will_retry,
                error_message,
                tokens_before,
                ..
            }) => {
                assert!(aborted);
                assert!(will_retry);
                assert_eq!(error_message.as_deref(), Some("boom"));
                assert_eq!(tokens_before, None);
            }
            other => panic!("expected CompactionEnd, got {other:?}"),
        }
    }

    #[test]
    fn queue_update_maps_steering_and_follow_up() {
        let value = json!({ "steering": ["a"], "followUp": ["b", "c"] });
        match map_pi_event(Some("queue_update"), &value) {
            Some(AgentEvent::QueueUpdate {
                steering,
                follow_up,
            }) => {
                assert_eq!(steering, vec!["a"]);
                assert_eq!(follow_up, vec!["b", "c"]);
            }
            other => panic!("expected QueueUpdate, got {other:?}"),
        }
    }

    #[test]
    fn queue_update_missing_arrays_default_empty() {
        match map_pi_event(Some("queue_update"), &json!({})) {
            Some(AgentEvent::QueueUpdate {
                steering,
                follow_up,
            }) => {
                assert!(steering.is_empty());
                assert!(follow_up.is_empty());
            }
            other => panic!("expected QueueUpdate, got {other:?}"),
        }
    }

    #[test]
    fn string_array_filters_non_strings_and_handles_missing() {
        let v = json!({ "xs": ["a", 1, "b", null] });
        assert_eq!(string_array(v.get("xs")), vec!["a", "b"]);
        assert!(string_array(v.get("missing")).is_empty());
        assert!(string_array(Some(&json!("not an array"))).is_empty());
    }

    // Extension UI coverage: input/editor become text dialogs carrying
    // placeholder/prefill; the five display methods become fire-and-forget events.
    #[test]
    fn input_dialog_carries_placeholder() {
        let v = json!({ "method": "input", "title": "Name?", "placeholder": "type here" });
        match classify_extension_ui("r1", "input", &v) {
            ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
                method,
                title,
                placeholder,
                prefill,
                ..
            }) => {
                assert_eq!(method, "input");
                assert_eq!(title, "Name?");
                assert_eq!(placeholder.as_deref(), Some("type here"));
                assert_eq!(prefill, None);
            }
            _ => panic!("expected input dialog"),
        }
    }

    #[test]
    fn editor_dialog_carries_prefill() {
        let v = json!({ "method": "editor", "title": "Edit", "prefill": "seed" });
        match classify_extension_ui("r2", "editor", &v) {
            ExtUiOutcome::Dialog(AgentEvent::PermissionRequest {
                method, prefill, ..
            }) => {
                assert_eq!(method, "editor");
                assert_eq!(prefill.as_deref(), Some("seed"));
            }
            _ => panic!("expected editor dialog"),
        }
    }

    #[test]
    fn fire_and_forget_methods_map_to_their_events() {
        assert!(matches!(
            classify_extension_ui("r", "notify", &json!({ "method": "notify", "message": "m", "notifyType": "warning" })),
            ExtUiOutcome::Notify(AgentEvent::Notify { notify_type, .. }) if notify_type.as_deref() == Some("warning")
        ));
        assert!(matches!(
            classify_extension_ui("r", "setStatus", &json!({ "method": "setStatus", "statusKey": "k", "statusText": "t" })),
            ExtUiOutcome::Notify(AgentEvent::SetStatus { status_key, .. }) if status_key == "k"
        ));
        assert!(matches!(
            classify_extension_ui("r", "setWidget", &json!({ "method": "setWidget", "widgetKey": "k", "widgetLines": ["a", "b"] })),
            ExtUiOutcome::Notify(AgentEvent::SetWidget { widget_lines: Some(lines), .. }) if lines == ["a", "b"]
        ));
        assert!(matches!(
            classify_extension_ui("r", "setTitle", &json!({ "method": "setTitle", "title": "T" })),
            ExtUiOutcome::Notify(AgentEvent::SetTitle { title }) if title == "T"
        ));
        assert!(matches!(
            classify_extension_ui("r", "set_editor_text", &json!({ "method": "set_editor_text", "text": "x" })),
            ExtUiOutcome::Notify(AgentEvent::SetEditorText { text }) if text == "x"
        ));
    }

    #[test]
    fn setstatus_without_text_clears_the_key() {
        match classify_extension_ui(
            "r",
            "setStatus",
            &json!({ "method": "setStatus", "statusKey": "k" }),
        ) {
            ExtUiOutcome::Notify(AgentEvent::SetStatus { status_text, .. }) => {
                assert_eq!(status_text, None);
            }
            _ => panic!("expected setStatus"),
        }
    }

    #[test]
    fn unknown_method_is_ignored() {
        assert!(matches!(
            classify_extension_ui("r", "somethingNew", &json!({ "method": "somethingNew" })),
            ExtUiOutcome::Ignore
        ));
    }

    #[test]
    fn spawn_sentinel_notify_maps_to_subagent_spawned() {
        let payload = r#"{"agentId":"a1","subagentType":"Explore","task":"read the README"}"#;
        let value = serde_json::json!({
            "type": "extension_ui_request",
            "id": "u1",
            "method": "notify",
            "message": format!("{SPAWN_NOTIFY_PREFIX}{payload}"),
        });
        match classify_extension_ui("u1", "notify", &value) {
            ExtUiOutcome::Notify(AgentEvent::SubagentSpawned {
                agent_id,
                subagent_type,
                task,
            }) => {
                assert_eq!(agent_id, "a1");
                assert_eq!(subagent_type, "Explore");
                assert_eq!(task, "read the README");
            }
            other => panic!("expected SubagentSpawned, got {other:?}"),
        }
    }

    #[test]
    fn plain_notify_is_unchanged() {
        let value = serde_json::json!({
            "type": "extension_ui_request", "id": "u2", "method": "notify", "message": "hello",
        });
        match classify_extension_ui("u2", "notify", &value) {
            ExtUiOutcome::Notify(AgentEvent::Notify { message, .. }) => {
                assert_eq!(message, "hello")
            }
            other => panic!("expected Notify, got {other:?}"),
        }
    }

    // HOY-215: await_with_dialog_grace charges its budget only against dead air
    // (no response and no outstanding dialog). Hermetic; start_paused
    // auto-advances tokio's virtual clock so these run instantly.
    #[tokio::test(start_paused = true)]
    async fn grace_returns_value_before_budget() {
        let (tx, rx) = oneshot::channel();
        tx.send(json!("ok")).unwrap();
        let out =
            await_with_dialog_grace(rx, Duration::from_secs(15), Duration::from_secs(1), || {
                false
            })
            .await;
        assert!(matches!(out, Ok(v) if v == json!("ok")));
    }

    #[tokio::test(start_paused = true)]
    async fn grace_reports_closed_when_sender_dropped() {
        let (tx, rx) = oneshot::channel::<Value>();
        drop(tx);
        let out =
            await_with_dialog_grace(rx, Duration::from_secs(15), Duration::from_secs(1), || {
                false
            })
            .await;
        assert!(matches!(out, Err(RequestError::Closed)));
    }

    #[tokio::test(start_paused = true)]
    async fn grace_times_out_on_dead_air() {
        // Keep the sender alive so the receiver is not Closed; with no dialog
        // outstanding the dead-air budget elapses and the wait times out.
        let (_tx, rx) = oneshot::channel::<Value>();
        let out =
            await_with_dialog_grace(rx, Duration::from_secs(15), Duration::from_secs(1), || {
                false
            })
            .await;
        assert!(matches!(out, Err(RequestError::TimedOut)));
    }

    #[tokio::test(start_paused = true)]
    async fn grace_suspends_budget_while_dialog_outstanding() {
        let (tx, rx) = oneshot::channel();
        // Answer well past the 15s budget; an outstanding dialog must keep the
        // countdown suspended so the late value still resolves, not times out.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(45)).await;
            let _ = tx.send(json!("late answer"));
        });
        let out =
            await_with_dialog_grace(rx, Duration::from_secs(15), Duration::from_secs(1), || true)
                .await;
        assert!(matches!(out, Ok(v) if v == json!("late answer")));
    }

    // HOY-193: the sidecar path precedence chain (env > dev > bundled).
    #[test]
    fn select_paths_env_override_wins() {
        let (bin, payload) = select_sidecar_paths(
            Some(PathBuf::from("/env/bin")),
            Some(PathBuf::from("/env/payload")),
            Some(PathBuf::from("/dev/pi-triple")),
            Some(PathBuf::from("/dev/pi-payload")),
            Some(Path::new("/exe")),
            Some(PathBuf::from("/res/pi-payload")),
        );
        assert_eq!(bin, PathBuf::from("/env/bin"));
        assert_eq!(payload, PathBuf::from("/env/payload"));
    }

    #[test]
    fn select_paths_prefers_dev_when_present() {
        let (bin, payload) = select_sidecar_paths(
            None,
            None,
            Some(PathBuf::from("/dev/pi-triple")),
            Some(PathBuf::from("/dev/pi-payload")),
            Some(Path::new("/exe")),
            Some(PathBuf::from("/res/pi-payload")),
        );
        assert_eq!(bin, PathBuf::from("/dev/pi-triple"));
        assert_eq!(payload, PathBuf::from("/dev/pi-payload"));
    }

    #[test]
    fn select_paths_bundled_branch() {
        // No env, no dev artifacts: a packaged app finds the externalBin next to
        // the exe (triple stripped) and the payload in the Tauri resource dir.
        let (bin, payload) = select_sidecar_paths(
            None,
            None,
            None,
            None,
            Some(Path::new("/app")),
            Some(PathBuf::from("/app/resources/pi-payload")),
        );
        assert_eq!(
            bin,
            Path::new("/app").join(format!("hoy-pi{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(payload, PathBuf::from("/app/resources/pi-payload"));
    }
}
