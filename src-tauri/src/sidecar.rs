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

    // Send an RPC command and await its correlated response. The `id` is
    // assigned here; callers pass the command body without one.
    pub async fn request(&self, mut command: Value) -> Result<Value, String> {
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

        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err("sidecar closed before responding".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "sidecar request timed out after {REQUEST_TIMEOUT:?}"
                ))
            }
        }
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
        let cancel = |id: &str| {
            let response = json!({
                "type": "extension_ui_response",
                "id": id,
                "cancelled": true,
            });
            if let Ok(text) = serde_json::to_string(&response) {
                let mut stdin = stdin.lock().unwrap();
                let _ = stdin
                    .write_all(format!("{text}\n").as_bytes())
                    .and_then(|_| stdin.flush());
            }
        };
        match method {
            "select" | "confirm" => {
                let event = AgentEvent::PermissionRequest {
                    request_id: id.to_string(),
                    method: method.to_string(),
                    title: value
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    message: value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    options: value.get("options").and_then(Value::as_array).map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    }),
                };
                let guard = sink.lock().unwrap();
                match guard.as_ref() {
                    Some(channel) => {
                        pending_ui.lock().unwrap().push(id.to_string());
                        let _ = channel.send(event);
                    }
                    // No streaming prompt is attached, so nothing can render or
                    // answer the dialog; cancel it instead of deadlocking.
                    None => cancel(id),
                }
            }
            // Dialogs Hoy has no UI for yet (input, editor).
            "input" | "editor" => cancel(id),
            // Fire-and-forget (notify, setStatus, setWidget, ...): no response.
            _ => {}
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
fn map_pi_event(ty: Option<&str>, value: &Value) -> Option<AgentEvent> {
    match ty? {
        "message_update" => {
            let inner = value.get("assistantMessageEvent")?;
            // Token deltas live in assistantMessageEvent.delta, NOT .text.
            // Thinking deltas are skipped: AgentEvent has no reasoning kind yet.
            if inner.get("type").and_then(Value::as_str) == Some("text_delta") {
                Some(AgentEvent::Text {
                    delta: inner.get("delta").and_then(Value::as_str)?.to_string(),
                })
            } else {
                None
            }
        }
        "message_end" => {
            // Surface a failed/aborted turn; agent_end still follows to finalize.
            let message = value.get("message")?;
            match message.get("stopReason").and_then(Value::as_str) {
                Some("error") | Some("aborted") => Some(AgentEvent::Error {
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
        _ => None,
    }
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
    pub fn new() -> Self {
        let (bin, payload) = resolve_sidecar_paths();
        let agent_dir = crate::pi_config::agent_dir().unwrap_or_else(|e| {
            eprintln!("[hoy-desktop] could not resolve agent dir: {e}");
            PathBuf::new()
        });
        Self {
            sessions: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            modes: Mutex::new(HashMap::new()),
            cwds: Mutex::new(HashMap::new()),
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

    // Spawn the boot control session in the manager's default cwd. The first
    // session spawned becomes the active one (used for model enumeration).
    pub fn spawn_session(&self) -> Result<SessionId, String> {
        let cwd = self.cwd.clone();
        let id = self.spawn_session_in(&cwd, None)?;
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
            None,
        )?;
        let id = format!("s{}", self.handle_counter.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().unwrap().insert(id.clone(), proc);
        self.cwds
            .lock()
            .unwrap()
            .insert(id.clone(), cwd.to_path_buf());
        Ok(id)
    }

    // Tear down a session's sidecar (panel close / thread delete). Dropping the
    // Arc runs PiProcess::drop, which kills and reaps the child. The Arc is
    // dropped outside the lock so Drop does not hold it.
    pub fn remove(&self, id: &str) {
        let old = self.sessions.lock().unwrap().remove(id);
        self.modes.lock().unwrap().remove(id);
        self.cwds.lock().unwrap().remove(id);
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
// Order: explicit env overrides, then the dev build under sidecar/, then next
// to the app executable (release). TODO(M4/release): wire externalBin so the
// release branch resolves against Tauri's resource dir.
fn resolve_sidecar_paths() -> (PathBuf, PathBuf) {
    let triple = env!("TARGET_TRIPLE");

    let env_bin = std::env::var_os("PI_SIDECAR_BIN").map(PathBuf::from);
    let env_payload = std::env::var_os("PI_SIDECAR_PAYLOAD").map(PathBuf::from);

    let dev_sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("sidecar"));
    let dev_bin = dev_sidecar.as_ref().map(|d| d.join(format!("pi-{triple}")));
    let dev_payload = dev_sidecar.as_ref().map(|d| d.join("pi-payload"));

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    let bin = env_bin
        .or_else(|| dev_bin.filter(|p| p.exists()))
        .or_else(|| exe_dir.as_ref().map(|d| d.join(format!("pi-{triple}"))))
        .unwrap_or_else(|| PathBuf::from(format!("pi-{triple}")));

    let payload = env_payload
        .or_else(|| dev_payload.filter(|p| p.exists()))
        .or_else(|| exe_dir.as_ref().map(|d| d.join("pi-payload")))
        .unwrap_or_else(|| PathBuf::from("pi-payload"));

    (bin, payload)
}

#[cfg(test)]
mod live_tests {
    use super::*;

    // Exercises the exact path the get_state command takes: spawn a sidecar via
    // the manager, then round-trip get_state against the live process. Requires
    // sidecar/pi-<triple> + pi-payload (run sidecar/build.sh), so it is ignored
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
            .spawn_session_in(&cwd, None)
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
            .spawn_session_in(&cwd, Some(&session_file))
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
}
