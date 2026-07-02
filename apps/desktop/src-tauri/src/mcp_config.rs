// MCP server config for the settings UI (HOY-232). Two branded files, both in
// the standard `{ "mcpServers": { name: spec } }` shape so a server declared for
// Cursor/Claude Code pastes straight in:
//   global  -> <agent_dir>/mcp.json          (~/.hoy/agent, ~/.hoyd/agent debug)
//   project -> <project>/.hoy/mcp.json        (branded project dir, HOY-222)
//
// The sidecar reads and merges these itself (packages/sidecar/pi-src/hoy-mcp.ts,
// loadMcpConfig): project wins on a name collision, ${ENV} in values is
// interpolated there. Rust owns only the read/write for this UI plus triggering
// a respawn on change. We read-modify-write the whole file so unknown top-level
// keys and other servers are preserved, and a malformed file never bricks the
// read (returns empty, same tolerance as pi_config). Secrets belong in ${ENV}
// references, not inline, so returning specs to the renderer for editing is fine.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::pi_config::agent_dir;

// Branded project config dir. Not namespaced for debug the way the agent dir is:
// the sidecar (hoy-mcp.ts) and build.sh both use ".hoy" for the project dir
// unconditionally, so Rust must match.
const PROJECT_CONFIG_DIR: &str = ".hoy";

// Serializes mcp.json mutations, same rationale as pi_config's auth lock: async
// commands can interleave and a stale read-modify-write would drop an entry.
static MCP_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    Global,
    Project,
}

// One server as shown/edited in the UI. `spec` is the raw JSON object under
// mcpServers[name] (command/args/env/cwd for stdio, url/headers for http,
// optional disabled). `transport` is derived for convenient rendering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub scope: McpScope,
    pub transport: String, // "stdio" | "http" | "unknown"
    pub disabled: bool,
    pub spec: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerList {
    // Editable: <agent_dir>/mcp.json.
    pub global: Vec<McpServerEntry>,
    // Editable: <project>/.hoy/mcp.json (the file this UI writes).
    pub project: Vec<McpServerEntry>,
    // Read-only here: <project>/.mcp.json, the standard cross-tool file. The
    // sidecar reads it so a repo's existing MCP servers work; users edit it
    // directly (it is shared with other MCP-aware tools), not through this UI.
    pub project_shared: Vec<McpServerEntry>,
}

fn global_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("mcp.json"))
}

fn project_path(project: &str) -> Result<PathBuf, String> {
    if project.trim().is_empty() {
        return Err("project path is required for project scope".to_string());
    }
    Ok(PathBuf::from(project).join(PROJECT_CONFIG_DIR).join("mcp.json"))
}

// The standard cross-tool file at the project root. Read-only from this UI; the
// sidecar merges it (packages/sidecar/pi-src/hoy-mcp.ts).
fn project_shared_path(project: &str) -> PathBuf {
    PathBuf::from(project).join(".mcp.json")
}

fn path_for(scope: McpScope, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        McpScope::Global => global_path(),
        McpScope::Project => project_path(project.unwrap_or("")),
    }
}

fn transport_of(spec: &Value) -> String {
    if spec.get("url").and_then(Value::as_str).is_some() {
        "http".to_string()
    } else if spec.get("command").and_then(Value::as_str).is_some() {
        "stdio".to_string()
    } else {
        "unknown".to_string()
    }
}

// Missing or malformed file -> empty object. Never error the read side: a bad
// mcp.json must not block the settings page from loading the other scope.
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

fn servers_map(config: &Map<String, Value>) -> Map<String, Value> {
    match config.get("mcpServers") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

fn entries_at(path: &Path, scope: McpScope) -> Vec<McpServerEntry> {
    let servers = servers_map(&read_config_at(path));
    let mut out: Vec<McpServerEntry> = servers
        .into_iter()
        .map(|(name, spec)| McpServerEntry {
            name,
            scope,
            transport: transport_of(&spec),
            disabled: spec.get("disabled").and_then(Value::as_bool).unwrap_or(false),
            spec,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
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

    let tmp = dir.join(format!("mcp.json.tmp-{}", std::process::id()));
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

fn upsert_at(path: &Path, name: &str, spec: Value) -> Result<(), String> {
    let _guard = MCP_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !spec.is_object() {
        return Err("server spec must be a JSON object".to_string());
    }
    let mut config = read_config_at(path);
    let mut servers = servers_map(&config);
    servers.insert(name.to_string(), spec);
    config.insert("mcpServers".to_string(), Value::Object(servers));
    write_config_atomic_at(path, &config)
}

fn remove_at(path: &Path, name: &str) -> Result<(), String> {
    let _guard = MCP_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut config = read_config_at(path);
    let mut servers = servers_map(&config);
    if servers.remove(name).is_none() {
        return Ok(());
    }
    config.insert("mcpServers".to_string(), Value::Object(servers));
    write_config_atomic_at(path, &config)
}

pub fn list(project: Option<&str>) -> Result<McpServerList, String> {
    let global = entries_at(&global_path()?, McpScope::Global);
    let (project_entries, project_shared) = match project {
        Some(p) if !p.trim().is_empty() => (
            entries_at(&project_path(p)?, McpScope::Project),
            entries_at(&project_shared_path(p), McpScope::Project),
        ),
        _ => (Vec::new(), Vec::new()),
    };
    Ok(McpServerList {
        global,
        project: project_entries,
        project_shared,
    })
}

pub fn save(scope: McpScope, project: Option<&str>, name: &str, spec: Value) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("server name is required".to_string());
    }
    upsert_at(&path_for(scope, project)?, name.trim(), spec)
}

pub fn remove(scope: McpScope, project: Option<&str>, name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("server name is required".to_string());
    }
    remove_at(&path_for(scope, project)?, name.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upsert_preserves_other_servers_and_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("hoy-mcp-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("mcp.json");
        std::fs::write(
            &path,
            r#"{"someTopLevel":true,"mcpServers":{"keep":{"command":"a"}}}"#,
        )
        .unwrap();

        upsert_at(&path, "added", json!({"url":"https://x"})).unwrap();

        let config = read_config_at(&path);
        assert_eq!(config.get("someTopLevel"), Some(&json!(true)));
        let servers = servers_map(&config);
        assert!(servers.contains_key("keep"));
        assert!(servers.contains_key("added"));

        let entries = entries_at(&path, McpScope::Global);
        assert_eq!(entries.len(), 2);
        let added = entries.iter().find(|e| e.name == "added").unwrap();
        assert_eq!(added.transport, "http");

        remove_at(&path, "keep").unwrap();
        let after = servers_map(&read_config_at(&path));
        assert!(!after.contains_key("keep"));
        assert!(after.contains_key("added"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_file_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("hoy-mcp-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("mcp.json");
        std::fs::write(&path, "{not valid json").unwrap();
        assert!(entries_at(&path, McpScope::Global).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
