// Hoy's own persistence: the projects -> threads tree, stored as workspace.json
// in the branded agent dir (~/.hoy/agent, via pi_config::agent_dir). This is the
// metadata layer; Pi owns the transcripts (SessionManager writes JSONL session
// files under the same dir). Each thread carries the durable sessionFile path so
// a reopened thread can SessionManager.open() its prior conversation.
//
// Read-modify-write is atomic (temp + rename), mirroring pi_config's auth.json
// handling. The live sidecar process id is NOT persisted (it is ephemeral); only
// sessionFile is durable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pi_config::agent_dir;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Workspace {
    #[serde(default)]
    pub projects: Vec<WsProject>,
    // The last project the user worked in, restored so the home launcher can
    // default a new thread to it across restarts. camelCase to match the
    // frontend Workspace shape; absent in pre-flag files.
    #[serde(rename = "activeProjectId", default)]
    pub active_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub threads: Vec<WsThread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsThread {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    #[serde(default)]
    pub session_file: Option<String>,
    #[serde(default)]
    pub archived: bool,
    // True once the user manually renamed the thread; pre-flag workspaces
    // default to false.
    #[serde(default)]
    pub renamed: bool,
    // Unsent composer text, restored into the editor on reopen.
    #[serde(default)]
    pub draft: Option<String>,
    // Permission mode (HOY-186); absent means default. The renderer re-applies
    // it to the thread's sidecar after spawn.
    #[serde(default)]
    pub permission_mode: Option<String>,
    // HOY-231: subagent orchestration. A spawned child thread's parent, so the
    // tree survives restart; absent for top-level threads and pre-HOY-231 files.
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub spawned_by: Option<SpawnedBy>,
    // Last-selected model (HOY-267): a cached hint so the sidebar can show the
    // thread's provider glyph on load without spawning the session. The session
    // JSONL remains the source of truth; the renderer reconciles this against
    // get_state after the thread is opened. Absent on new/session-less threads
    // and pre-HOY-267 files.
    #[serde(default)]
    pub model: Option<WsModelRef>,
    // Goal Mode (HOY-263): the thread's goal loop state, if any. Absent for
    // threads with no goal and pre-HOY-263 files. On load, the frontend
    // (store.ts initWorkspace) demotes a restored "active" goal to "paused"
    // and resets its counters so it does not auto-run; a "met"/"cleared"
    // goal is dropped rather than restored. Persisted as-is here; the reset
    // is a load-time frontend concern, not a workspace.rs one.
    #[serde(default)]
    pub goal: Option<WsGoal>,
}

// A provider/model identity pair, mirroring the frontend ModelRef. Cached on the
// thread so the sidebar row icon renders before the session is hydrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsModelRef {
    pub provider: String,
    pub id: String,
}

// Mirror of the frontend ThreadGoal (src/state/goal.ts). Keep the two in sync
// (AGENTS.md): same fields, same camelCase names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsGoal {
    pub condition: String,
    pub status: String,
    pub turns: u32,
    pub tokens_baseline: u64,
    pub tokens_used: u64,
    pub started_at: u64,
    pub cap_turns: u32,
    #[serde(default)]
    pub evaluator_model: Option<WsModelRef>,
    #[serde(default)]
    pub last_reason: Option<String>,
    // HOY-298 (Goal Mode v2): optional deterministic verify gate. Mirrors the
    // ThreadGoal fields; #[serde(default)] so pre-v2 workspaces still load. Kept
    // in sync with the frontend so a persisted verifyCommand/verifyCwd is not
    // silently dropped on save/load.
    #[serde(default)]
    pub verify_command: Option<String>,
    #[serde(default)]
    pub verify_cwd: Option<String>,
    // HOY-299 (Goal Mode v3): which evaluator the loop uses ("transcript" default
    // when absent, or "auditor" for the independent read-only auditor). Mirrors
    // the ThreadGoal field; #[serde(default)] so pre-v3 workspaces still load.
    // (lastVerifyExit remains intentionally NOT persisted, like lastReason's
    // transient sibling.)
    #[serde(default)]
    pub evaluator_kind: Option<String>,
}

// Which agent spawned this thread and under what role, for child threads
// created via subagent orchestration (HOY-231).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedBy {
    pub r#type: String,
    pub agent_id: String,
}

fn workspace_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("workspace.json"))
}

fn load_at(path: &Path) -> Result<Workspace, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Workspace::default()),
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("parse workspace.json: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Workspace::default()),
        Err(e) => Err(format!("read workspace.json: {e}")),
    }
}

fn save_at(path: &Path, workspace: &Workspace) -> Result<(), String> {
    let dir = path.parent().ok_or("workspace.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut body = serde_json::to_vec_pretty(workspace)
        .map_err(|e| format!("serialize workspace.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("workspace.json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

pub fn load() -> Result<Workspace, String> {
    load_at(&workspace_path()?)
}

pub fn save(workspace: &Workspace) -> Result<(), String> {
    save_at(&workspace_path()?, workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "hoy-ws-test-{}-{}-{}",
                std::process::id(),
                tag,
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ))
            .join("workspace.json")
    }

    fn sample() -> Workspace {
        Workspace {
            active_project_id: Some("p1".into()),
            projects: vec![WsProject {
                id: "p1".into(),
                name: "hoy".into(),
                path: Some("/home/u/code/hoy".into()),
                threads: vec![WsThread {
                    id: "t1".into(),
                    title: "ticket HOY-28".into(),
                    updated_at: 1_717_000_000_000,
                    session_file: Some("/home/u/.hoy/sessions/abc/s1.jsonl".into()),
                    archived: false,
                    renamed: true,
                    draft: Some("unsent composer text".into()),
                    permission_mode: Some("acceptEdits".into()),
                    parent_thread_id: None,
                    spawned_by: None,
                    model: Some(WsModelRef {
                        provider: "anthropic".into(),
                        id: "claude-opus-4-8".into(),
                    }),
                    goal: Some(WsGoal {
                        condition: "tests pass".into(),
                        status: "active".into(),
                        turns: 3,
                        tokens_baseline: 100,
                        tokens_used: 250,
                        started_at: 1_717_000_000_000,
                        cap_turns: 25,
                        evaluator_model: Some(WsModelRef {
                            provider: "anthropic".into(),
                            id: "claude-haiku".into(),
                        }),
                        last_reason: Some("still working".into()),
                        verify_command: Some("bun test".into()),
                        verify_cwd: None,
                        evaluator_kind: Some("auditor".into()),
                    }),
                }],
            }],
        }
    }

    #[test]
    fn missing_file_loads_empty() {
        let path = temp_path("missing");
        assert!(load_at(&path).unwrap().projects.is_empty());
    }

    #[test]
    fn round_trips_projects_and_threads() {
        let path = temp_path("round");
        save_at(&path, &sample()).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.active_project_id.as_deref(), Some("p1"));
        let p = &loaded.projects[0];
        assert_eq!(p.name, "hoy");
        assert_eq!(p.path.as_deref(), Some("/home/u/code/hoy"));
        let t = &p.threads[0];
        assert_eq!(t.title, "ticket HOY-28");
        assert_eq!(t.updated_at, 1_717_000_000_000);
        assert!(t.session_file.is_some());
        assert!(!t.archived);
        assert!(t.renamed);
        assert_eq!(t.draft.as_deref(), Some("unsent composer text"));
        let m = t.model.as_ref().expect("model persists");
        assert_eq!(m.provider, "anthropic");
        assert_eq!(m.id, "claude-opus-4-8");
        let g = t.goal.as_ref().expect("goal persists");
        assert_eq!(g.condition, "tests pass");
        assert_eq!(g.status, "active");
        assert_eq!(g.turns, 3);
        assert_eq!(g.tokens_baseline, 100);
        assert_eq!(g.tokens_used, 250);
        assert_eq!(g.started_at, 1_717_000_000_000);
        assert_eq!(g.cap_turns, 25);
        let em = g
            .evaluator_model
            .as_ref()
            .expect("evaluator_model persists");
        assert_eq!(em.provider, "anthropic");
        assert_eq!(em.id, "claude-haiku");
        assert_eq!(g.last_reason.as_deref(), Some("still working"));
        assert_eq!(g.verify_command.as_deref(), Some("bun test"));
        assert_eq!(g.verify_cwd, None);
        assert_eq!(g.evaluator_kind.as_deref(), Some("auditor"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn goal_serializes_camel_case_and_omits_when_absent() {
        let path = temp_path("goal");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"goal\""));
        assert!(raw.contains("\"tokensBaseline\": 100"));
        assert!(raw.contains("\"tokensUsed\": 250"));
        assert!(raw.contains("\"capTurns\": 25"));
        assert!(raw.contains("\"lastReason\": \"still working\""));
        assert!(!raw.contains("tokens_baseline"));

        // Pre-HOY-263 files (no goal key) load with None rather than failing.
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].goal.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn model_serializes_camel_case_and_omits_when_absent() {
        let path = temp_path("model");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"model\""));
        assert!(raw.contains("\"provider\": \"anthropic\""));
        assert!(raw.contains("\"id\": \"claude-opus-4-8\""));

        // Pre-HOY-267 files (no model key) load with None rather than failing.
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].model.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_replaces_existing_atomically() {
        let path = temp_path("replace");
        save_at(&path, &sample()).unwrap();
        let mut next = Workspace::default();
        next.projects.push(WsProject {
            id: "p2".into(),
            name: "jiji".into(),
            path: None,
            threads: vec![],
        });
        save_at(&path, &next).unwrap();
        let loaded = load_at(&path).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "jiji");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn pre_draft_files_load_with_none() {
        let path = temp_path("nodraft");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"projects":[{"id":"p1","name":"hoy","threads":[{"id":"t1","title":"T","updatedAt":1}]}]}"#,
        )
        .unwrap();
        let loaded = load_at(&path).unwrap();
        assert!(loaded.projects[0].threads[0].draft.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn camelcase_keys_match_frontend_shape() {
        let path = temp_path("camel");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"updatedAt\""));
        assert!(raw.contains("\"sessionFile\""));
        assert!(raw.contains("\"activeProjectId\""));
        assert!(!raw.contains("updated_at"));
        assert!(!raw.contains("active_project_id"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn child_thread_fields_round_trip_camel_case() {
        let ws = Workspace {
            projects: vec![WsProject {
                id: "p1".into(),
                name: "P".into(),
                path: None,
                threads: vec![WsThread {
                    id: "t2".into(),
                    title: "child".into(),
                    updated_at: 1,
                    session_file: Some("f".into()),
                    archived: false,
                    renamed: false,
                    draft: None,
                    permission_mode: None,
                    parent_thread_id: Some("t1".into()),
                    spawned_by: Some(SpawnedBy {
                        r#type: "Explore".into(),
                        agent_id: "a1".into(),
                    }),
                    model: None,
                    goal: None,
                }],
            }],
            active_project_id: None,
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("\"parentThreadId\":\"t1\""));
        assert!(json.contains("\"spawnedBy\""));
        assert!(json.contains("\"type\":\"Explore\""));
        assert!(json.contains("\"agentId\":\"a1\""));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.projects[0].threads[0].parent_thread_id.as_deref(),
            Some("t1")
        );
    }
}
