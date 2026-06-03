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
use tokio::sync::oneshot;

use crate::reader::JsonlFramer;

pub type SessionId = String;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

// A single spawned `pi --mode rpc` child plus the machinery to issue
// request/response RPC commands against it. Unsolicited events (no `id`) are
// dropped in M1; M3 routes them to a per-session Tauri Channel.
pub struct PiProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
}

impl PiProcess {
    fn spawn(bin: &Path, payload: &Path, cwd: &Path) -> Result<Arc<PiProcess>, String> {
        let mut child = Command::new(bin)
            // --no-session is M1-only; M4 drops it so Pi persists sessions.
            .args(["--mode", "rpc", "--no-session", "--offline", "--no-context-files"])
            .env("PI_PACKAGE_DIR", payload)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", bin.display()))?;

        let stdin = child.stdin.take().ok_or("child has no stdin")?;
        let stdout = child.stdout.take().ok_or("child has no stdout")?;
        let stderr = child.stderr.take().ok_or("child has no stderr")?;

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        {
            let pending = pending.clone();
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
                                    route_message(&pending, value);
                                }
                            }
                        }
                    }
                }
                // Stream closed: fail any in-flight requests so callers unblock.
                pending.lock().unwrap().clear();
            });
        }

        // Drain stderr so a chatty child never blocks on a full pipe.
        thread::spawn(move || {
            let mut sink = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut sink);
        });

        Ok(Arc::new(PiProcess {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
        }))
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
                Err(format!("sidecar request timed out after {REQUEST_TIMEOUT:?}"))
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
    value: Value,
) {
    let is_response = value.get("type").and_then(Value::as_str) == Some("response");
    if let (true, Some(id)) = (is_response, value.get("id").and_then(Value::as_str)) {
        if let Some(tx) = pending.lock().unwrap().remove(id) {
            let _ = tx.send(value);
            return;
        }
    }
    // Unsolicited event (text_delta, tool_execution_*, agent_end, ...).
    // Routed to the session Channel in M3.
}

pub struct SidecarManager {
    sessions: Mutex<HashMap<SessionId, Arc<PiProcess>>>,
    active: Mutex<Option<SessionId>>,
    handle_counter: AtomicUsize,
    bin: PathBuf,
    payload: PathBuf,
    cwd: PathBuf,
}

impl SidecarManager {
    pub fn new() -> Self {
        let (bin, payload) = resolve_sidecar_paths();
        Self {
            sessions: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            handle_counter: AtomicUsize::new(1),
            bin,
            payload,
            cwd: std::env::temp_dir(),
        }
    }

    // Spawn a new sidecar, register it under a fresh SessionId, and return that
    // id. The first session spawned becomes the active one.
    pub fn spawn_session(&self) -> Result<SessionId, String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        let proc = PiProcess::spawn(&self.bin, &self.payload, &self.cwd)?;
        let id = format!("s{}", self.handle_counter.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().unwrap().insert(id.clone(), proc);
        let mut active = self.active.lock().unwrap();
        if active.is_none() {
            *active = Some(id.clone());
        }
        Ok(id)
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
    // caches auth in memory at startup). The model selection survives because Pi
    // persists defaultModel to settings.json and re-reads it on spawn. The old
    // Arc is dropped outside the lock so its Drop (kill + wait) does not hold it.
    pub fn respawn(&self, id: &str) -> Result<(), String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        let proc = PiProcess::spawn(&self.bin, &self.payload, &self.cwd)?;
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
}
