use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::events::{
    AgentEvent, CompactionResult, ImageContent, ModelInfo, PiState, SessionStats, SlashCommand,
};
use crate::mcp_config::{self, McpScope, McpServerList};
use crate::pi_config::{self, ProviderAuth, ProviderInfo};
use crate::sidecar::SidecarManager;
use crate::subagents_config::{self, SubagentScope};
use crate::workspace::{self, Workspace};

// Pull `data` out of an RPC response envelope, surfacing Pi's error string on
// failure. Pi responses are {type:"response", command, id, success, data, error}.
fn unwrap_response(response: Value, what: &str) -> Result<Value, String> {
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        let message = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(what);
        return Err(message.to_string());
    }
    response
        .get("data")
        .cloned()
        .ok_or_else(|| format!("{what} response missing data"))
}

// For RPC commands whose success response carries no `data` (prompt, abort): just
// confirm success and surface Pi's error string otherwise. unwrap_response would
// wrongly reject these for the absent data field.
fn check_success(response: &Value, what: &str) -> Result<(), String> {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(what)
        .to_string())
}

#[tauri::command]
pub async fn get_state(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<PiState, String> {
    let process = manager.get(&session_id)?;
    let response = process.request(json!({ "type": "get_state" })).await?;
    let data = unwrap_response(response, "get_state")?;
    serde_json::from_value(data).map_err(|e| format!("decode PiState: {e}"))
}

#[tauri::command]
pub async fn list_models(manager: State<'_, SidecarManager>) -> Result<Vec<ModelInfo>, String> {
    let id = manager
        .active_session_id()
        .ok_or("no active session for list_models")?;
    let process = manager.get(&id)?;
    let response = process
        .request(json!({ "type": "get_available_models" }))
        .await?;
    let data = unwrap_response(response, "get_available_models")?;
    let models = data
        .get("models")
        .cloned()
        .ok_or("get_available_models response missing models")?;
    serde_json::from_value(models).map_err(|e| format!("decode models: {e}"))
}

// List the session's available slash commands for the composer "/" autocomplete
// (HOY-223): extension commands, prompt templates, and skills. Execution reuses
// the existing prompt path (a message starting with "/name" dispatches), so this
// only feeds the picker.
#[tauri::command]
pub async fn get_commands(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<Vec<SlashCommand>, String> {
    let process = manager.get(&session_id)?;
    let response = process.request(json!({ "type": "get_commands" })).await?;
    let data = unwrap_response(response, "get_commands")?;
    let commands = data
        .get("commands")
        .cloned()
        .ok_or("get_commands response missing commands")?;
    serde_json::from_value(commands).map_err(|e| format!("decode commands: {e}"))
}

#[tauri::command]
pub async fn set_model(
    session_id: String,
    provider: String,
    model_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    let response = process
        .request(json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model_id,
        }))
        .await?;
    unwrap_response(response, "set_model")?;
    Ok(())
}

#[tauri::command]
pub async fn set_thinking_level(
    session_id: String,
    level: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    let response = process
        .request(json!({
            "type": "set_thinking_level",
            "level": level,
        }))
        .await?;
    check_success(&response, "set_thinking_level")?;
    Ok(())
}

#[tauri::command]
pub async fn compact(
    session_id: String,
    custom_instructions: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<CompactionResult, String> {
    let process = manager.get(&session_id)?;
    let mut body = json!({ "type": "compact" });
    if let Some(ci) = custom_instructions.filter(|s| !s.trim().is_empty()) {
        body["customInstructions"] = json!(ci);
    }
    // Compaction runs an LLM summarization that can exceed REQUEST_TIMEOUT before
    // its response (the CompactionResult) lands, so use a longer budget (HOY-229).
    let response = process
        .request_with_timeout(body, Duration::from_secs(180))
        .await?;
    let data = unwrap_response(response, "compact")?;
    serde_json::from_value(data).map_err(|e| format!("compact result: {e}"))
}

#[tauri::command]
pub async fn set_auto_compaction(
    session_id: String,
    enabled: bool,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    let response = process
        .request(json!({ "type": "set_auto_compaction", "enabled": enabled }))
        .await?;
    check_success(&response, "set_auto_compaction")?;
    Ok(())
}

// Respawn every idle live session so each sidecar reloads auth.json (HOY-196).
// Pi caches credentials at process start. For each session the current
// transcript file is captured live via get_session_stats (only pi knows it
// once a fresh session first writes) and reopened by the respawn, so pi-side
// context survives; cwd and permission mode come from the manager mirrors.
// Streaming sessions are skipped: killing a turn mid-flight is worse than
// stale auth, and the close/reopen path still refreshes them later.
pub(crate) async fn respawn_idle_sessions(manager: &SidecarManager) {
    for (id, process) in manager.snapshot() {
        if process.is_streaming() {
            continue;
        }
        let session_file = match process
            .request(json!({ "type": "get_session_stats" }))
            .await
        {
            Ok(response) => response["data"]["sessionFile"].as_str().map(str::to_string),
            // A wedged process still gets a fresh child; worst case the thread
            // is hydrated from the renderer's persisted sessionFile on reopen.
            Err(_) => None,
        };
        if let Err(e) = manager.respawn(&id, session_file.as_deref()) {
            eprintln!("[hoy-desktop] respawn {id} after credential change failed: {e}");
        }
    }
}

// Persist a provider API key into Pi's auth.json, then respawn idle sidecars
// so they reload credentials. The key value is never returned to the renderer.
#[tauri::command]
pub async fn save_provider_key(
    provider: String,
    key: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    pi_config::set_api_key(&provider, &key)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_provider_key(
    provider: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    pi_config::remove_provider(&provider)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}

#[tauri::command]
pub fn provider_statuses(providers: Vec<String>) -> Result<Vec<ProviderAuth>, String> {
    pi_config::statuses(&providers)
}

#[tauri::command]
pub fn supported_providers() -> Vec<ProviderInfo> {
    pi_config::supported_providers()
}

// MCP server config (HOY-232). Global lives in the branded agent dir; project
// lives in <project>/.hoy/mcp.json. `project_path` is the active project's dir,
// needed only for project-scope reads/writes; the renderer already knows it.
// Writes respawn idle sidecars so each reloads the merged config, same path as
// a credential change.
#[tauri::command]
pub fn list_mcp_servers(project_path: Option<String>) -> Result<McpServerList, String> {
    mcp_config::list(project_path.as_deref())
}

#[tauri::command]
pub async fn save_mcp_server(
    scope: McpScope,
    name: String,
    spec: Value,
    project_path: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    mcp_config::save(scope, project_path.as_deref(), &name, spec)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_mcp_server(
    scope: McpScope,
    name: String,
    project_path: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    mcp_config::remove(scope, project_path.as_deref(), &name)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}

#[tauri::command]
pub fn list_subagents(
    cwd: String,
    manager: State<'_, SidecarManager>,
) -> Result<serde_json::Value, String> {
    let path = if cwd.trim().is_empty() {
        std::env::temp_dir()
    } else {
        PathBuf::from(cwd)
    };
    manager.list_subagents(&path)
}

#[tauri::command]
pub async fn set_subagent_enabled(
    scope: SubagentScope,
    name: String,
    enabled: bool,
    project_path: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    subagents_config::set_enabled(scope, project_path.as_deref(), &name, enabled)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}

#[tauri::command]
pub fn active_session_id(manager: State<'_, SidecarManager>) -> Option<String> {
    manager.active_session_id()
}

// Spawn a thread's own sidecar in its project directory. An empty cwd falls back
// to the manager's default (temp) dir so threads without a project path still
// run. `session_file` (M4) reopens a thread's existing transcript; None starts
// fresh. `subagent_type` (HOY-231) brands a spawned child session's system
// prompt; `permission_mode` seeds it with the parent's mode. `depth` (HOY-245)
// is the subagent chain's recursion depth, relayed to the sidecar as
// HOY_SUBAGENT_DEPTH; root sessions pass 0. `require_subagent_approval`
// (HOY-248) relays the renderer pref to the sidecar as
// HOY_REQUIRE_SUBAGENT_APPROVAL; false (default) spawns without a consent
// prompt. Returns the new sessionId the thread stores and drives.
#[tauri::command]
pub async fn create_session(
    cwd: String,
    session_file: Option<String>,
    subagent_type: Option<String>,
    permission_mode: Option<String>,
    depth: u32,
    require_subagent_approval: bool,
    inherit_from_session: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<String, String> {
    let path = if cwd.trim().is_empty() {
        std::env::temp_dir()
    } else {
        PathBuf::from(cwd)
    };
    manager.spawn_session_in(
        &path,
        session_file.as_deref(),
        permission_mode.as_deref(),
        subagent_type.as_deref(),
        depth,
        require_subagent_approval,
        inherit_from_session.as_deref(),
    )
}

// Tear down a thread's sidecar (panel close / thread delete). The control session
// is never removed so model enumeration keeps working.
#[tauri::command]
pub fn close_session(session_id: String, manager: State<'_, SidecarManager>) {
    if manager.active_session_id().as_deref() == Some(session_id.as_str()) {
        return;
    }
    manager.remove(&session_id);
}

// Load a session's full transcript as raw Pi AgentMessage objects; the renderer
// folds them into turns (lib/turns.ts). Used to restore a reopened thread.
#[tauri::command]
pub async fn get_messages(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<Vec<Value>, String> {
    let process = manager.get(&session_id)?;
    let response = process.request(json!({ "type": "get_messages" })).await?;
    let data = unwrap_response(response, "get_messages")?;
    let messages = data
        .get("messages")
        .cloned()
        .ok_or("get_messages response missing messages")?;
    serde_json::from_value(messages).map_err(|e| format!("decode messages: {e}"))
}

// Read the session's tree entries (0.80.3, HOY-221): the flat, id/parentId-linked
// SessionEntry list plus the current leafId. Read side of the fork/tree gap; a
// future /tree navigator UI consumes it. `since` (optional) returns only entries
// after that entry id for incremental reads.
//
// Returned as serde_json::Value, not a typed struct: SessionEntry is a nine-variant
// union (message/thinking_level_change/model_change/compaction/branch_summary/
// custom/custom_message/label/session_info) whose `message` variant embeds Pi's
// AgentMessage, which get_messages already carries opaquely as Value. Mirroring
// that union in Rust would duplicate a large, still-evolving surface for no gain
// at a pure read passthrough. The renderer types the shape (lib/types.ts).
#[tauri::command]
pub async fn get_entries(
    session_id: String,
    since: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let process = manager.get(&session_id)?;
    let mut body = json!({ "type": "get_entries" });
    if let Some(since) = since.filter(|s| !s.trim().is_empty()) {
        body["since"] = json!(since);
    }
    let response = process.request(body).await?;
    unwrap_response(response, "get_entries")
}

// Read the session tree snapshot (0.80.3, HOY-221): a recursive SessionTreeNode
// forest (each node = entry + children + resolved label) plus the current leafId.
// Same passthrough rationale as get_entries; returned as Value.
#[tauri::command]
pub async fn get_tree(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<Value, String> {
    let process = manager.get(&session_id)?;
    let response = process.request(json!({ "type": "get_tree" })).await?;
    unwrap_response(response, "get_tree")
}

// Permanently delete a thread's transcript JSONL (thread delete). Guarded to the
// branded sessions dir so a stray path can never remove arbitrary files. A
// missing file is treated as success (already gone).
#[tauri::command]
pub fn delete_session_file(session_file: String) -> Result<(), String> {
    let sessions_root = pi_config::agent_dir()?.join("sessions");
    let path = PathBuf::from(&session_file);
    // starts_with is component-wise, so a `..` component would pass the prefix
    // check while resolving outside the sessions dir. Reject any traversal.
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
        || !path.starts_with(&sessions_root)
    {
        return Err("refusing to delete outside the sessions dir".into());
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete session file: {e}")),
    }
}

// Toggle the OS keep-awake behavior at runtime (HOY-188). The renderer syncs the
// persisted `keepAwakeWhileStreaming` pref here on boot and whenever it changes;
// the keep-awake owner thread reads the flag each poll. No session needed: the
// feature is app-global, not per-thread. Default (before any call) is enabled.
#[tauri::command]
pub fn set_keep_awake(enabled: bool) {
    crate::keep_awake::set_enabled(enabled);
}

#[tauri::command]
pub fn load_workspace() -> Result<Workspace, String> {
    workspace::load()
}

#[tauri::command]
pub fn save_workspace(workspace: Workspace) -> Result<(), String> {
    workspace::save(&workspace)
}

// Attach the prompt's Channel to the session, send Pi a `prompt`, and return once
// preflight is accepted. Tokens, tool calls, and the terminal `done` then stream
// over the Channel from the reader thread; the renderer drives the UI from those.
// Assemble the prompt RPC body. images[] and streamingBehavior are omitted when
// absent so an idle text-only turn sends exactly {type:"prompt",message}.
// streamingBehavior ("steer" | "followUp") only has meaning while a turn streams;
// Pi ignores it when idle (HOY-205 / HOY-218).
fn build_prompt_body(
    message: &str,
    images: Option<Vec<ImageContent>>,
    streaming_behavior: Option<String>,
) -> Value {
    let mut body = json!({ "type": "prompt", "message": message });
    if let Some(images) = images {
        if !images.is_empty() {
            body["images"] = json!(images);
        }
    }
    if let Some(behavior) = streaming_behavior {
        body["streamingBehavior"] = json!(behavior);
    }
    body
}

#[tauri::command]
pub async fn send_prompt(
    session_id: String,
    message: String,
    images: Option<Vec<ImageContent>>,
    streaming_behavior: Option<String>,
    on_event: Channel<AgentEvent>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    process.set_sink(on_event);
    // request_with_dialog_grace, not request: a slash command in this prompt may
    // block its preflight on an extension UI dialog past REQUEST_TIMEOUT (HOY-215).
    let response = match process
        .request_with_dialog_grace(build_prompt_body(&message, images, streaming_behavior))
        .await
    {
        Ok(response) => response,
        Err(e) => {
            process.clear_sink();
            return Err(e);
        }
    };
    // The prompt response is a bare {success:true} acknowledgement with no data
    // (it fires at preflight; the turn streams over the Channel).
    if let Err(e) = check_success(&response, "prompt") {
        process.clear_sink();
        return Err(e);
    }
    Ok(())
}

// Queue a steer/follow-up into the turn that is already streaming (HOY-218).
// Deliberately takes NO Channel and does NOT touch the sink: the active turn's
// sink stays attached so the queued message's delivery, and the run's single
// terminal Done, keep flowing over the original channel. (Re-invoking send_prompt
// with the same JS Channel silently orphans delivery: a second invoke rebinds the
// channel and events after the swap never reach the original onmessage.)
#[tauri::command]
pub async fn enqueue_prompt(
    session_id: String,
    message: String,
    images: Option<Vec<ImageContent>>,
    streaming_behavior: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    let response = process
        .request_with_dialog_grace(build_prompt_body(
            &message,
            images,
            Some(streaming_behavior),
        ))
        .await?;
    check_success(&response, "prompt")
}

#[tauri::command]
pub async fn get_session_stats(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<SessionStats, String> {
    let process = manager.get(&session_id)?;
    let response = process
        .request(json!({ "type": "get_session_stats" }))
        .await?;
    let data = unwrap_response(response, "get_session_stats")?;
    serde_json::from_value(data).map_err(|e| format!("decode SessionStats: {e}"))
}

// HOY-262: aggregate local usage stats from pi's session transcripts. Pure disk
// read, so it runs on the blocking pool rather than tying up an async worker.
#[tauri::command]
pub async fn get_usage_stats() -> Result<crate::usage_stats::UsageReport, String> {
    tauri::async_runtime::spawn_blocking(crate::usage_stats::compute_usage)
        .await
        .map_err(|e| format!("usage stats task failed: {e}"))
}

#[tauri::command]
pub async fn abort(session_id: String, manager: State<'_, SidecarManager>) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    // A pending approval dialog blocks the agent before abort can take effect;
    // cancel it first so the blocked tool_call resumes (as a denial) and the
    // abort lands (HOY-186).
    process.cancel_pending_ui();
    let response = process.request(json!({ "type": "abort" })).await?;
    check_success(&response, "abort")
}

// Answer a pending approval card (HOY-186). `value` answers a select dialog,
// `confirmed` a confirm dialog; `cancelled: true` declines either. Writes the
// extension_ui_response the blocked sidecar is waiting on.
#[tauri::command]
pub fn respond_permission(
    session_id: String,
    request_id: String,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: Option<bool>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    let process = manager.get(&session_id)?;
    process.respond_ui(&request_id, value, confirmed, cancelled.unwrap_or(false))
}

// Switch a thread's permission mode (HOY-186). The /hoy_mode extension command
// executes immediately even mid-stream; the manager mirror keeps the mode
// across respawns via HOY_PERMISSION_MODE.
#[tauri::command]
pub async fn set_permission_mode(
    session_id: String,
    mode: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    const MODES: [&str; 4] = ["default", "acceptEdits", "plan", "autonomous"];
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    let process = manager.get(&session_id)?;
    let response = process
        .request(json!({ "type": "prompt", "message": format!("/hoy_mode {mode}") }))
        .await?;
    check_success(&response, "set_permission_mode")?;
    manager.set_mode(&session_id, &mode);
    Ok(())
}

// One entry in the composer @ context picker's file list (HOY-220). `path` is
// relative to the project root (forward-slashed); `name` is the leaf.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    path: String,
    name: String,
    is_dir: bool,
}

// A single context file is inlined into the prompt text, so cap it: large files
// would blow the context window and are rarely what the user means to attach.
const MAX_CONTEXT_FILE_BYTES: usize = 256 * 1024;

// List paths under a project root for the @ context picker (HOY-220). Pi has no
// file-listing RPC, so this is Hoy-side. Gitignore-aware (require_git(false) so a
// .gitignore is honored even without a .git dir); `query` is a case-insensitive
// substring filter over the relative path; results are capped at `limit`.
#[tauri::command]
pub fn list_project_paths(
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<PathEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let needle = query.to_lowercase();
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(&root_path)
        .git_ignore(true)
        .require_git(false)
        .hidden(true)
        .parents(false)
        .build();
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !needle.is_empty() && !rel.to_lowercase().contains(&needle) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(PathEntry {
            path: rel,
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

// Read a project file for inlining as @ context (HOY-220). Path-guarded to the
// project root (like delete_session_file) and size-capped. `path` is relative to
// `root`; a canonicalized prefix re-check defends against symlink escapes.
#[tauri::command]
pub fn read_context_file(root: String, path: String) -> Result<String, String> {
    let rel = PathBuf::from(&path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("refusing to read outside the project root".into());
    }
    let root_path = PathBuf::from(&root);
    let canon_root = root_path
        .canonicalize()
        .map_err(|e| format!("resolve root: {e}"))?;
    let canon = root_path
        .join(&rel)
        .canonicalize()
        .map_err(|e| format!("resolve file: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err("refusing to read outside the project root".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("read file: {e}"))?;
    let truncated = bytes.len() > MAX_CONTEXT_FILE_BYTES;
    let end = bytes.len().min(MAX_CONTEXT_FILE_BYTES);
    let mut content = String::from_utf8_lossy(&bytes[..end]).into_owned();
    if truncated {
        content.push_str("\n... [truncated]");
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_body_message_only() {
        let body = build_prompt_body("hi", None, None);
        assert_eq!(body, json!({ "type": "prompt", "message": "hi" }));
        assert!(body.get("images").is_none());
        assert!(body.get("streamingBehavior").is_none());
    }

    #[test]
    fn build_prompt_body_with_images() {
        let images = vec![ImageContent {
            kind: "image".into(),
            data: "AAAA".into(),
            mime_type: "image/png".into(),
        }];
        let body = build_prompt_body("look", Some(images), None);
        let arr = body.get("images").and_then(Value::as_array).unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "image");
        assert_eq!(arr[0]["data"], "AAAA");
        assert_eq!(arr[0]["mimeType"], "image/png");
    }

    #[test]
    fn build_prompt_body_empty_images_omitted() {
        let body = build_prompt_body("hi", Some(vec![]), None);
        assert!(body.get("images").is_none());
    }

    #[test]
    fn build_prompt_body_with_streaming_behavior() {
        let body = build_prompt_body("more", None, Some("steer".into()));
        assert_eq!(body["streamingBehavior"], "steer");
    }

    // get_entries / get_tree return the whole response `data` object (both
    // {..., leafId} shapes), unlike get_messages which pulls a single sub-field.
    // Pin that passthrough and the error path here since the commands themselves
    // need a live sidecar to exercise (HOY-221).
    #[test]
    fn unwrap_response_returns_full_data_object() {
        let response = json!({
            "type": "response",
            "command": "get_tree",
            "success": true,
            "data": { "tree": [], "leafId": null },
        });
        let data = unwrap_response(response, "get_tree").unwrap();
        assert!(data.get("tree").unwrap().as_array().unwrap().is_empty());
        assert!(data.get("leafId").unwrap().is_null());
    }

    #[test]
    fn unwrap_response_surfaces_error_string() {
        let response = json!({
            "type": "response",
            "command": "get_entries",
            "success": false,
            "error": "no session",
        });
        assert_eq!(
            unwrap_response(response, "get_entries"),
            Err("no session".into())
        );
    }

    use std::sync::atomic::{AtomicUsize, Ordering};

    // A unique scratch dir per test so the parallel test runner never collides.
    fn scratch_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hoy_ctx_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_project_paths_respects_gitignore_and_filters() {
        let root = scratch_dir();
        std::fs::write(root.join("keep.txt"), "keep").unwrap();
        std::fs::write(root.join("ignored.txt"), "ignored").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();

        let all = list_project_paths(root.to_string_lossy().into(), String::new(), 50).unwrap();
        let names: Vec<&str> = all.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"keep.txt"));
        assert!(!names.contains(&"ignored.txt"));

        let filtered =
            list_project_paths(root.to_string_lossy().into(), "keep".into(), 50).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].path, "keep.txt");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_context_file_rejects_traversal() {
        let root = scratch_dir();
        assert!(read_context_file(root.to_string_lossy().into(), "../secret".into()).is_err());
        assert!(read_context_file(root.to_string_lossy().into(), "/etc/passwd".into()).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_context_file_caps_size() {
        let root = scratch_dir();
        let big = "a".repeat(MAX_CONTEXT_FILE_BYTES + 5000);
        std::fs::write(root.join("big.txt"), &big).unwrap();

        let content = read_context_file(root.to_string_lossy().into(), "big.txt".into()).unwrap();
        assert!(content.ends_with("[truncated]"));
        assert!(content.len() <= MAX_CONTEXT_FILE_BYTES + "\n... [truncated]".len());

        std::fs::remove_dir_all(&root).ok();
    }
}
