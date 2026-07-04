// Subscription OAuth login bridge. Pi's RPC has no auth command, so login runs
// as a one-shot invocation of the sidecar binary (HOY_OAUTH_LOGIN) that speaks a
// small manual-paste protocol over its pipes: JSONL events out, single-line
// responses in. This module spawns that child, streams its events to the
// renderer over a Channel, feeds back the pasted code, and respawns idle
// sidecars once login persists the oauth entry into auth.json (pi_config reads
// the same file for status). Only one login runs at a time.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::thread;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::events::{OAuthEvent, OAuthSelectOption};
use crate::sidecar::SidecarManager;

#[derive(Default)]
pub struct OAuthLogin {
    inner: Mutex<Option<Session>>,
}

struct Session {
    child: Child,
    stdin: ChildStdin,
}

impl OAuthLogin {
    // Store the new login, reaping any previous child. Reaping here (not in the
    // reader thread) avoids a race where a finished login's thread would kill a
    // freshly started one.
    fn replace(&self, session: Session) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        *guard = Some(session);
    }

    fn clear(&self) {
        if let Some(mut old) = self.inner.lock().unwrap().take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    // Reap a finished login's child once its reader thread exits, so it does not
    // linger as a defunct process and a later oauth_login_submit sees "no active
    // login" rather than writing to a dead pipe. Guarded on pid so an older
    // login's thread cannot reap a newer login that replace() has since stored.
    fn reap_if_current(&self, pid: u32) {
        let mut guard = self.inner.lock().unwrap();
        if guard.as_ref().map(|s| s.child.id()) == Some(pid) {
            if let Some(mut old) = guard.take() {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        let session = guard.as_mut().ok_or("no active login")?;
        session
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| session.stdin.flush())
            .map_err(|e| e.to_string())
    }
}

fn map_event(v: &Value) -> Option<OAuthEvent> {
    let str_at = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    match v.get("type").and_then(Value::as_str)? {
        "auth_url" => Some(OAuthEvent::AuthUrl {
            url: str_at("url")?,
            instructions: str_at("instructions"),
        }),
        "device_code" => Some(OAuthEvent::DeviceCode {
            user_code: str_at("userCode").unwrap_or_default(),
            verification_uri: str_at("verificationUri").unwrap_or_default(),
            interval_seconds: v.get("intervalSeconds").and_then(Value::as_u64),
            expires_in_seconds: v.get("expiresInSeconds").and_then(Value::as_u64),
        }),
        "progress" => Some(OAuthEvent::Progress {
            message: str_at("message").unwrap_or_default(),
        }),
        "prompt" => Some(OAuthEvent::Prompt {
            prompt_type: str_at("promptType").unwrap_or_else(|| "text".into()),
            message: str_at("message").unwrap_or_default(),
            placeholder: str_at("placeholder"),
        }),
        "select" => Some(OAuthEvent::Select {
            message: str_at("message").unwrap_or_default(),
            options: v
                .get("options")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| {
                            Some(OAuthSelectOption {
                                id: o.get("id")?.as_str()?.to_string(),
                                label: o
                                    .get("label")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }),
        "done" => Some(OAuthEvent::Done),
        "error" => Some(OAuthEvent::Error {
            message: str_at("message").unwrap_or_else(|| "login failed".into()),
        }),
        _ => None,
    }
}

// Start a login. Returns immediately; progress arrives on `on_event`. The
// browser URL is opened by the renderer (it also keeps a fallback link), so this
// stays free of an opener dependency.
#[tauri::command]
pub fn oauth_login_start(
    provider: String,
    on_event: Channel<OAuthEvent>,
    app: AppHandle,
    manager: State<'_, SidecarManager>,
    oauth: State<'_, OAuthLogin>,
) -> Result<(), String> {
    let mut command = manager.oauth_login_command(&provider)?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn login: {e}"))?;

    let stdin = child.stdin.take().ok_or("login child has no stdin")?;
    let stdout = child.stdout.take().ok_or("login child has no stdout")?;
    let stderr = child.stderr.take().ok_or("login child has no stderr")?;
    let pid = child.id();
    oauth.replace(Session { child, stdin });

    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[oauth:stderr] {line}");
        }
    });

    let app = app.clone();
    thread::spawn(move || {
        let mut terminal = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(event) = map_event(&value) else {
                continue;
            };
            let is_done = matches!(event, OAuthEvent::Done);
            let is_error = matches!(event, OAuthEvent::Error { .. });
            let _ = on_event.send(event);
            if is_done {
                terminal = true;
                // Credentials landed in auth.json; reload idle sidecars so the
                // new provider is usable without a restart (mirrors key save).
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = handle.state::<SidecarManager>();
                    crate::commands::respawn_idle_sessions(&manager).await;
                });
                break;
            }
            if is_error {
                terminal = true;
                break;
            }
        }
        if !terminal {
            let _ = on_event.send(OAuthEvent::Error {
                message: "login process exited unexpectedly".into(),
            });
        }
        // The loop ended, so this child is finished (done, error, or closed
        // pipe). Reap it — but only if it is still the current login, since a
        // newer one started via replace() now owns `inner`.
        app.state::<OAuthLogin>().reap_if_current(pid);
    });

    Ok(())
}

// Feed back one line the flow asked for (a pasted code / redirect URL, or a
// selected option id).
#[tauri::command]
pub fn oauth_login_submit(text: String, oauth: State<'_, OAuthLogin>) -> Result<(), String> {
    oauth.write_line(&format!("{text}\n"))
}

#[tauri::command]
pub fn oauth_login_cancel(oauth: State<'_, OAuthLogin>) {
    oauth.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_auth_url_with_and_without_instructions() {
        let e = map_event(&json!({"type":"auth_url","url":"https://x/y"})).unwrap();
        assert!(matches!(
            e,
            OAuthEvent::AuthUrl {
                instructions: None,
                ..
            }
        ));
        let e =
            map_event(&json!({"type":"auth_url","url":"https://x","instructions":"go"})).unwrap();
        match e {
            OAuthEvent::AuthUrl { url, instructions } => {
                assert_eq!(url, "https://x");
                assert_eq!(instructions.as_deref(), Some("go"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn auth_url_without_url_is_none() {
        assert!(map_event(&json!({"type":"auth_url"})).is_none());
    }

    #[test]
    fn maps_prompt_defaults_type_to_text() {
        match map_event(&json!({"type":"prompt","message":"paste"})).unwrap() {
            OAuthEvent::Prompt {
                prompt_type,
                message,
                placeholder,
            } => {
                assert_eq!(prompt_type, "text");
                assert_eq!(message, "paste");
                assert!(placeholder.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn maps_select_options_filtering_malformed() {
        match map_event(&json!({
            "type":"select","message":"pick",
            "options":[{"id":"a","label":"A"},{"label":"no id"},{"id":"b","label":"B"}]
        }))
        .unwrap()
        {
            OAuthEvent::Select { options, .. } => {
                let ids: Vec<_> = options.iter().map(|o| o.id.as_str()).collect();
                assert_eq!(ids, vec!["a", "b"]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn maps_device_code_and_terminal_events() {
        assert!(matches!(
            map_event(
                &json!({"type":"device_code","userCode":"WXYZ","verificationUri":"https://v"})
            )
            .unwrap(),
            OAuthEvent::DeviceCode { .. }
        ));
        assert!(matches!(
            map_event(&json!({"type":"done"})).unwrap(),
            OAuthEvent::Done
        ));
        assert!(matches!(
            map_event(&json!({"type":"error","message":"nope"})).unwrap(),
            OAuthEvent::Error { .. }
        ));
    }

    #[test]
    fn unknown_type_is_none() {
        assert!(map_event(&json!({"type":"chatter"})).is_none());
        assert!(map_event(&json!({"nope":true})).is_none());
    }
}
