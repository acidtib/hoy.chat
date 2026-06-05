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

    let mut body =
        serde_json::to_vec_pretty(workspace).map_err(|e| format!("serialize workspace.json: {e}"))?;
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
            projects: vec![WsProject {
                id: "p1".into(),
                name: "hoy".into(),
                path: Some("/home/u/code/hoy".into()),
                threads: vec![WsThread {
                    id: "t1".into(),
                    title: "ticket HOY-28".into(),
                    updated_at: 1_717_000_000_000,
                    session_file: Some("/home/u/.hoy/agent/sessions/abc/s1.jsonl".into()),
                    archived: false,
                    renamed: true,
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
        let p = &loaded.projects[0];
        assert_eq!(p.name, "hoy");
        assert_eq!(p.path.as_deref(), Some("/home/u/code/hoy"));
        let t = &p.threads[0];
        assert_eq!(t.title, "ticket HOY-28");
        assert_eq!(t.updated_at, 1_717_000_000_000);
        assert!(t.session_file.is_some());
        assert!(!t.archived);
        assert!(t.renamed);
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
    fn camelcase_keys_match_frontend_shape() {
        let path = temp_path("camel");
        save_at(&path, &sample()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"updatedAt\""));
        assert!(raw.contains("\"sessionFile\""));
        assert!(!raw.contains("updated_at"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
