// Throwaway M0 spike. Proves the M0 acceptance criterion: a Rust process spawns
// the bundled Pi sidecar (bun-compiled binary + asset payload) and round-trips
// get_state over JSONL. Deleted when M1 lands the real SidecarManager/reader.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);

fn main() {
    let sidecar_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("m0-harness must live under sidecar/")
        .to_path_buf();
    let bin = sidecar_dir.join(format!("pi-{TARGET_TRIPLE}"));
    let payload = sidecar_dir.join("pi-payload");

    for p in [&bin, &payload] {
        if !p.exists() {
            eprintln!("FAIL: missing {}. Run sidecar/build.sh first.", p.display());
            std::process::exit(1);
        }
    }

    match round_trip(&bin, &payload) {
        Ok(session_id) => {
            println!("\nPASS: bundled sidecar answered get_state. sessionId={session_id}");
        }
        Err(e) => {
            eprintln!("\nFAIL: {e}");
            std::process::exit(1);
        }
    }
}

fn round_trip(bin: &Path, payload: &Path) -> Result<String, String> {
    // PI_PACKAGE_DIR points Pi at its bun-binary assets (package.json, theme/,
    // export-html/, assets/) decoupled from the executable's own location, which
    // is what the Tauri sidecar will do at spawn time.
    let mut child = Command::new(bin)
        .args(["--mode", "rpc", "--no-session", "--offline", "--no-context-files"])
        .env("PI_PACKAGE_DIR", payload)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", bin.display()))?;

    let mut stdin = child.stdin.take().ok_or("no child stdin")?;
    let stdout = child.stdout.take().ok_or("no child stdout")?;
    let mut stderr = child.stderr.take().ok_or("no child stderr")?;

    let (tx, rx) = mpsc::channel::<Result<serde_json::Value, String>>();
    let reader = thread::spawn(move || read_get_state_response(stdout, &tx));

    let request = serde_json::json!({ "type": "get_state", "id": "m0-rust" });
    let line = format!("{request}\n");
    println!("-> {}", line.trim_end());
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("write request: {e}"))?;

    let outcome = match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(Ok(value)) => {
            println!("<- {}", serde_json::to_string_pretty(&value).unwrap_or_default());
            extract_session_id(&value)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("no get_state response within {REPLY_TIMEOUT:?}")),
    };

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();

    if outcome.is_err() {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        let buf = buf.trim();
        if !buf.is_empty() {
            eprintln!("--- sidecar stderr ---\n{buf}");
        }
    }
    outcome
}

// Mirrors Pi's jsonl.js framing exactly: records are delimited by LF only; a
// trailing CR is stripped. read_until(b'\n') never splits on U+2028/U+2029, so
// those separators inside JSON string values pass through intact. Do not swap
// this for anything that treats Unicode separators as line breaks.
fn read_get_state_response(
    stdout: std::process::ChildStdout,
    tx: &mpsc::Sender<Result<serde_json::Value, String>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => {
                let _ = tx.send(Err("sidecar stdout closed before get_state response".into()));
                return;
            }
            Ok(_) => {}
            Err(e) => {
                let _ = tx.send(Err(format!("read stdout: {e}")));
                return;
            }
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        if bytes.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                let raw = String::from_utf8_lossy(&bytes);
                let _ = tx.send(Err(format!("invalid JSONL line: {e}\n  raw: {raw}")));
                return;
            }
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("response")
            && value.get("command").and_then(|v| v.as_str()) == Some("get_state")
        {
            let _ = tx.send(Ok(value));
            return;
        }
        // Ignore any unsolicited events emitted before the response.
    }
}

fn extract_session_id(value: &serde_json::Value) -> Result<String, String> {
    if value.get("success").and_then(|v| v.as_bool()) != Some(true) {
        let err = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("get_state success=false: {err}"));
    }
    value
        .get("data")
        .and_then(|d| d.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing data.sessionId".to_string())
}
