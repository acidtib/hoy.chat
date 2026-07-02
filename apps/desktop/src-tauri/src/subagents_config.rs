use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use crate::pi_config::agent_dir;

const PROJECT_CONFIG_DIR: &str = ".hoy";
static SUBAGENTS_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentScope {
    Global,
    Project,
}

fn global_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("subagents.json"))
}

fn project_path(project: &str) -> Result<PathBuf, String> {
    if project.trim().is_empty() {
        return Err("project path is required for project scope".to_string());
    }
    Ok(PathBuf::from(project).join(PROJECT_CONFIG_DIR).join("subagents.json"))
}

fn path_for(scope: SubagentScope, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        SubagentScope::Global => global_path(),
        SubagentScope::Project => project_path(project.unwrap_or("")),
    }
}

// read_config_at + write_config_atomic_at cloned from mcp_config.rs (verbatim,
// only the tmp filename literal changes to "subagents.json.tmp-{pid}").

// Missing or malformed file -> empty object. Never error the read side: a bad
// subagents.json must not block the settings page from loading the other scope.
fn read_config_at(path: &Path) -> Map<String, Value> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Map::new(),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        Err(_) => Map::new(),
    }
}

// Atomic replace, preserving unknown top-level keys (the caller mutates the map).
// Mirrors pi_config::write_auth_map_atomic_at. 0600 because an inline secret,
// while discouraged, is possible.
fn write_config_atomic_at(path: &Path, config: &Map<String, Value>) -> Result<(), String> {
    let dir = path.parent().ok_or("mcp.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }

    let mut body = serde_json::to_vec_pretty(&Value::Object(config.clone()))
        .map_err(|e| format!("serialize mcp.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("subagents.json.tmp-{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        f.write_all(&body)
            .and_then(|_| f.flush())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

fn disabled_vec(config: &Map<String, Value>) -> Vec<String> {
    match config.get("disabled") {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn set_disabled_at(path: &Path, name: &str, disabled: bool) -> Result<(), String> {
    let _guard = SUBAGENTS_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut config = read_config_at(path);
    let mut list = disabled_vec(&config);
    let present = list.iter().any(|n| n == name);
    if disabled && !present {
        list.push(name.to_string());
    } else if !disabled && present {
        list.retain(|n| n != name);
    } else {
        return Ok(());
    }
    config.insert("disabled".to_string(), Value::Array(list.into_iter().map(Value::String).collect()));
    write_config_atomic_at(path, &config)
}

pub fn set_enabled(scope: SubagentScope, project: Option<&str>, name: &str, enabled: bool) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("subagent name is required".to_string());
    }
    set_disabled_at(&path_for(scope, project)?, name.trim(), !enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disable_then_enable_round_trips_and_preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("hoy-sub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("subagents.json");
        // Seed an unknown top-level key to prove read-modify-write preserves it.
        std::fs::write(&path, serde_json::to_vec(&json!({ "note": "keep", "disabled": [] })).unwrap()).unwrap();

        set_disabled_at(&path, "Reviewer", true).unwrap();
        let after: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["note"], "keep");
        assert_eq!(after["disabled"], json!(["Reviewer"]));

        set_disabled_at(&path, "Reviewer", false).unwrap();
        let after2: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after2["disabled"], json!([]));
        std::fs::remove_dir_all(&dir).ok();
    }
}
