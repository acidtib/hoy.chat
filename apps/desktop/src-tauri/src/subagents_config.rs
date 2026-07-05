use crate::pi_config::agent_dir;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    Ok(PathBuf::from(project)
        .join(PROJECT_CONFIG_DIR)
        .join("subagents.json"))
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
    let dir = path.parent().ok_or("subagents.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }

    let mut body = serde_json::to_vec_pretty(&Value::Object(config.clone()))
        .map_err(|e| format!("serialize subagents.json: {e}"))?;
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

fn name_vec(config: &Map<String, Value>, key: &str) -> Vec<String> {
    match config.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

// Store an empty list as an absent key so subagents.json stays minimal.
fn put_list(config: &mut Map<String, Value>, key: &str, list: Vec<String>) {
    if list.is_empty() {
        config.remove(key);
    } else {
        config.insert(
            key.to_string(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
}

fn ensure_present(list: &mut Vec<String>, name: &str) -> bool {
    if list.iter().any(|n| n == name) {
        false
    } else {
        list.push(name.to_string());
        true
    }
}

fn ensure_absent(list: &mut Vec<String>, name: &str) -> bool {
    let before = list.len();
    list.retain(|n| n != name);
    list.len() != before
}

// Read the override config, let `mutate` edit the (enabled, disabled) name lists,
// and write back only if it reports a change. The single read-modify-write for the
// two-sided override, shared by set_enabled_at and the delete override-clear so the
// list maintenance lives in one place. The CALLER must already hold
// SUBAGENTS_MUTATION_LOCK (this is lock-free so a caller can span it across other
// file work in the same critical section).
fn mutate_override_locked(
    path: &Path,
    mutate: impl FnOnce(&mut Vec<String>, &mut Vec<String>) -> bool,
) -> Result<(), String> {
    let mut config = read_config_at(path);
    let mut enabled_list = name_vec(&config, "enabled");
    let mut disabled_list = name_vec(&config, "disabled");
    if !mutate(&mut enabled_list, &mut disabled_list) {
        return Ok(());
    }
    put_list(&mut config, "enabled", enabled_list);
    put_list(&mut config, "disabled", disabled_list);
    write_config_atomic_at(path, &config)
}

// Two-sided override (HOY-244): a name lives in exactly one of `enabled` /
// `disabled`, or neither (frontmatter default). Recording explicit intent in
// both directions keeps the settings toggle authoritative even for a type that
// ships `enabled: false` in its .md frontmatter.
fn set_enabled_at(path: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let _guard = SUBAGENTS_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    mutate_override_locked(path, |enabled_list, disabled_list| {
        if enabled {
            let added = ensure_present(enabled_list, name);
            let removed = ensure_absent(disabled_list, name);
            added || removed
        } else {
            let added = ensure_present(disabled_list, name);
            let removed = ensure_absent(enabled_list, name);
            added || removed
        }
    })
}

pub fn set_enabled(
    scope: SubagentScope,
    project: Option<&str>,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("subagent name is required".to_string());
    }
    set_enabled_at(&path_for(scope, project)?, name.trim(), enabled)
}

// HOY-254 (Slice 1): the write path for custom subagent types. Rust serializes a
// type into a `<scope>/agents/<name>.md` (global agent dir or <project>/.hoy/
// agents); the sidecar's hoy-agents-registry.ts is the single READER. This is the
// single-parser invariant: because Rust only ever SERIALIZES and never parses a
// .md, the two sides can never drift on precedence, tool validation, or defaults.

// The built-in type names (hoy-agents-registry.ts BUILTIN_SUBAGENTS), lowercased.
// A custom .md must not reuse one of these case-insensitively: the registry keys
// types by name, so a file named e.g. Explore.md would shadow the built-in. Rust
// rejects the write so a built-in can never be masked by a user file.
const BUILTIN_NAMES: [&str; 3] = ["general-purpose", "explore", "plan"];

// The fields a custom type carries, deserialized from the write command's `def`
// arg (camelCase from the renderer). Mirrors SubagentDef/SubagentWrite on the TS
// side. `enabled` is absent by design: a new type is enabled by default and the
// on/off state is owned by the two-sided override in subagents.json (set_enabled),
// not the .md. The Option is kept so a caller CAN ship a type disabled, but the
// renderer does not.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub prompt_mode: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub inherit_context: Option<bool>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub body: String,
}

fn scope_label(scope: SubagentScope) -> &'static str {
    match scope {
        SubagentScope::Global => "global",
        SubagentScope::Project => "project",
    }
}

// The agents dir a scope's .md files live in: <agent_dir>/agents for global,
// <project>/.hoy/agents for project. Mirrors how the registry loader resolves the
// same two layers (hoy-agents-registry.ts loadSubagentRegistry).
fn agents_dir(scope: SubagentScope, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        SubagentScope::Global => Ok(agent_dir()?.join("agents")),
        SubagentScope::Project => {
            let p = project.unwrap_or("");
            if p.trim().is_empty() {
                return Err("project path is required for project scope".to_string());
            }
            Ok(PathBuf::from(p).join(PROJECT_CONFIG_DIR).join("agents"))
        }
    }
}

// A type's name becomes its `<name>.md` file AND its registry key, so it must be a
// safe slug: letters, digits, hyphen, underscore only. This rejects path
// separators, dots, and spaces, so a name can never traverse out of the agents
// dir or shadow another file. "general-purpose" (a built-in) is a valid slug, so
// the built-in check below is separate.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// A name safe to use as a single filename component: non-empty, bounded, and free
// of any path separator or traversal so it can never escape the agents dir. Laxer
// than is_safe_name (it allows dots and spaces) so the UI can still delete or
// overwrite a hand-authored file whose name is not a strict slug (the registry
// reader keys types by raw filename and imposes no slug rule). New names still go
// through the strict validate_name; this only gates operations on files that
// already exist on disk.
fn is_path_component_safe(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && !name.chars().any(|c| c == '/' || c == '\\' || c == '\0')
}

fn validate_name(name: &str) -> Result<(), String> {
    if !is_safe_name(name) {
        return Err(format!(
            "subagent name must be 1-64 characters of letters, digits, hyphen, or underscore: {name:?}"
        ));
    }
    if BUILTIN_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!(
            "{name:?} is a built-in subagent name and cannot be reused"
        ));
    }
    Ok(())
}

// A YAML double-quoted scalar, escaping the characters the `yaml` parser the
// sidecar uses (via parseFrontmatter) treats specially. Double-quoting keeps an
// arbitrary description/model/thinking value from breaking the frontmatter (a
// colon, a leading special char), and escaping keeps quotes/backslashes/newlines
// intact through the round-trip.
fn yaml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

// Serialize a custom type to its .md text: a YAML frontmatter block carrying ONLY
// the keys the user set, then the body (the system prompt). The keys mirror
// EXACTLY what hoy-agents-registry.ts parseAgentFile reads: description, tools,
// prompt_mode, model, thinking, enabled, inherit_context, max_turns. Omitted /
// null / default fields are left out so the file stays minimal and the sidecar
// applies its own defaults on read (enabled defaults true, prompt_mode replace,
// inherit_context false). Body follows the closing `---`.
fn render_agent_md(def: &SubagentDef) -> String {
    let mut fm = String::new();
    if let Some(desc) = def.description.as_deref() {
        if !desc.trim().is_empty() {
            fm.push_str(&format!("description: {}\n", yaml_string(desc)));
        }
    }
    // Always write the tools key, even for an empty list. The registry reads an
    // absent key as FULL access but an explicit `tools: []` as zero tools, so
    // emitting the list verbatim keeps "what the form shows is what the agent gets":
    // no selection means no tools, never a silent escalation to the full set.
    let items: Vec<String> = def.tools.iter().map(|t| yaml_string(t)).collect();
    fm.push_str(&format!("tools: [{}]\n", items.join(", ")));
    // prompt_mode is a tiny required selector (replace|append); written always so
    // the mode a form chose is explicit in the file.
    fm.push_str(&format!("prompt_mode: {}\n", yaml_string(&def.prompt_mode)));
    if let Some(model) = def.model.as_deref() {
        if !model.trim().is_empty() {
            fm.push_str(&format!("model: {}\n", yaml_string(model)));
        }
    }
    if let Some(thinking) = def.thinking.as_deref() {
        if !thinking.trim().is_empty() {
            fm.push_str(&format!("thinking: {}\n", yaml_string(thinking)));
        }
    }
    // enabled defaults true in the registry (enabled !== false), so only a
    // disabled type needs the key; writing `enabled: true` would be redundant.
    if def.enabled == Some(false) {
        fm.push_str("enabled: false\n");
    }
    // inherit_context defaults false in the registry (=== true), so only write it on.
    if def.inherit_context == Some(true) {
        fm.push_str("inherit_context: true\n");
    }
    if let Some(mt) = def.max_turns {
        if mt > 0 {
            fm.push_str(&format!("max_turns: {mt}\n"));
        }
    }
    // The parser trims the body, so a single trailing newline is harmless and
    // leaves the file ending cleanly.
    format!("---\n{fm}---\n{}\n", def.body.trim_end())
}

// Atomic replace for a subagent .md, tmp-then-rename so a crash mid-write never
// leaves a half-written file the sidecar would try to parse. Mirrors
// write_config_atomic_at; 0600/0700 for the same reason (the body is user content
// kept private).
fn write_md_atomic_at(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("agent .md path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("agent .md path has no file name")?;
    let tmp = dir.join(format!("{file_name}.tmp-{}", std::process::id()));
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
        f.write_all(contents.as_bytes())
            .and_then(|_| f.flush())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

fn is_builtin_name(name: &str) -> bool {
    BUILTIN_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

// Author a custom type: serialize it to <scope>/agents/<name>.md. With
// overwrite=false (create) a new name must be a strict slug that is not a built-in
// and does not already exist, so a create never clobbers another type. With
// overwrite=true (edit) the file must already exist and is replaced atomically in a
// single rename (write_md_atomic_at) -- no delete-then-write window that could lose
// the agent if the write fails. An edit keeps the same filename, so it accepts any
// existing traversal-safe name (including a hand-authored non-slug).
pub fn write_subagent(
    scope: SubagentScope,
    project: Option<&str>,
    def: &SubagentDef,
    overwrite: bool,
) -> Result<(), String> {
    let name = def.name.trim();
    let _guard = SUBAGENTS_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let path = agents_dir(scope, project)?.join(format!("{name}.md"));
    if overwrite {
        if !is_path_component_safe(name) {
            return Err(format!("subagent name is not a safe filename: {name:?}"));
        }
        // The no-shadowing invariant holds on the edit path too: even though a
        // built-in-named file can only exist if hand-authored (create rejects it),
        // the write command must never help maintain a shadow of general-purpose /
        // explore / plan.
        if is_builtin_name(name) {
            return Err(format!(
                "{name:?} is a built-in subagent name and cannot be reused"
            ));
        }
        if !path.exists() {
            return Err(format!(
                "no {} subagent named {name:?} to overwrite",
                scope_label(scope)
            ));
        }
    } else {
        validate_name(name)?;
        if path.exists() {
            return Err(format!(
                "a {} subagent named {name:?} already exists",
                scope_label(scope)
            ));
        }
    }
    write_md_atomic_at(&path, &render_agent_md(def))
}

// Remove a custom type's .md. Idempotent (a missing file is not an error), same
// tolerance as the MCP remove path. Accepts any traversal-safe name so a
// hand-authored non-slug file (e.g. my.agent.md, which the registry loads fine) is
// still deletable from the UI.
pub fn delete_subagent(
    scope: SubagentScope,
    project: Option<&str>,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if !is_path_component_safe(name) {
        return Err(format!("subagent name is not a safe filename: {name:?}"));
    }
    let path = agents_dir(scope, project)?.join(format!("{name}.md"));
    let override_path = path_for(scope, project)?;
    // Hold the lock across both the file removal and the override clear so a
    // concurrent create + set_enabled of the same name cannot slip in between and
    // have its fresh override stripped.
    let _guard = SUBAGENTS_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove {}: {e}", path.display())),
    }
    // Clear a stale enabled/disabled override so it does not silently apply to a
    // future same-named type -- but ONLY for a custom name. A built-in-named override
    // belongs to the built-in (whose file, if any, was just a shadow), so wiping it
    // would silently re-enable a built-in the user disabled. Best-effort: the file is
    // already gone (the delete's contract), so an override-write hiccup must not
    // report the whole delete as failed.
    if !is_builtin_name(name) {
        if let Err(e) = mutate_override_locked(&override_path, |enabled_list, disabled_list| {
            let removed_enabled = ensure_absent(enabled_list, name);
            let removed_disabled = ensure_absent(disabled_list, name);
            removed_enabled || removed_disabled
        }) {
            eprintln!(
                "[hoy] delete_subagent removed {name:?} but failed to clear its override: {e}"
            );
        }
    }
    Ok(())
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
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({ "note": "keep", "disabled": [] })).unwrap(),
        )
        .unwrap();

        set_enabled_at(&path, "Reviewer", false).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["note"], "keep");
        assert_eq!(after["disabled"], json!(["Reviewer"]));
        // An empty list is stored as an absent key, not `[]`.
        assert!(after.get("enabled").is_none());

        set_enabled_at(&path, "Reviewer", true).unwrap();
        let after2: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Enabling moves the name from disabled to enabled (two-sided override),
        // so a frontmatter-disabled type can be forced on from the settings toggle.
        assert!(after2.get("disabled").is_none());
        assert_eq!(after2["enabled"], json!(["Reviewer"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    // A def with the advanced fields set but thinking/enabled left unset, so the
    // test can assert both that set fields serialize and that unset ones do not.
    fn sample_def(name: &str) -> SubagentDef {
        SubagentDef {
            name: name.to_string(),
            description: Some("A red-team reviewer: finds bugs.".to_string()),
            tools: vec!["read".to_string(), "grep".to_string()],
            prompt_mode: "append".to_string(),
            model: Some("sonnet".to_string()),
            thinking: None,
            enabled: None,
            inherit_context: Some(true),
            max_turns: Some(5),
            body: "You are a reviewer.".to_string(),
        }
    }

    #[test]
    fn write_subagent_serializes_expected_frontmatter_and_omits_unset() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-write-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        write_subagent(
            SubagentScope::Project,
            Some(proj.to_str().unwrap()),
            &sample_def("Reviewer"),
            false,
        )
        .unwrap();
        let md =
            std::fs::read_to_string(proj.join(".hoy").join("agents").join("Reviewer.md")).unwrap();

        // The keys the sidecar parser reads, with the values as set.
        assert!(md.contains("description: \"A red-team reviewer: finds bugs.\""));
        assert!(md.contains("tools: [\"read\", \"grep\"]"));
        assert!(md.contains("prompt_mode: \"append\""));
        assert!(md.contains("model: \"sonnet\""));
        assert!(md.contains("inherit_context: true"));
        assert!(md.contains("max_turns: 5"));
        // Body follows the closing delimiter.
        assert!(md.trim_end().ends_with("You are a reviewer."));
        // Unset (None) fields must not be serialized at all.
        assert!(!md.contains("thinking:"));
        assert!(!md.contains("enabled:"));

        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn write_subagent_rejects_builtin_bad_slug_and_duplicate() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-reject-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();

        // Built-in names, case-insensitively, cannot be reused (no shadowing).
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("explore"),
            false
        )
        .is_err());
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("General-Purpose"),
            false
        )
        .is_err());
        // Unsafe slugs (path traversal, spaces) are rejected on create.
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("../evil"),
            false
        )
        .is_err());
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("has space"),
            false
        )
        .is_err());

        // A fresh name writes; the same name again is a duplicate (create-only).
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
            false
        )
        .is_ok());
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
            false
        )
        .is_err());

        // delete_subagent removes the file and is idempotent.
        delete_subagent(SubagentScope::Project, Some(p), "Reviewer").unwrap();
        assert!(!proj
            .join(".hoy")
            .join("agents")
            .join("Reviewer.md")
            .exists());
        delete_subagent(SubagentScope::Project, Some(p), "Reviewer").unwrap();

        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn overwrite_replaces_in_place_and_refuses_to_create() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-ow-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        let md_path = proj.join(".hoy").join("agents").join("Reviewer.md");

        // overwrite=true on a name with no file is rejected (edit must not create).
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
            true
        )
        .is_err());

        // Create, then overwrite in place: a single atomic write, no delete needed.
        write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
            false,
        )
        .unwrap();
        let mut edited = sample_def("Reviewer");
        edited.body = "Edited prompt.".to_string();
        write_subagent(SubagentScope::Project, Some(p), &edited, true).unwrap();
        let md = std::fs::read_to_string(&md_path).unwrap();
        assert!(md.trim_end().ends_with("Edited prompt."));

        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn delete_clears_stale_enabled_disabled_override() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-clr-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        let json_path = proj.join(".hoy").join("subagents.json");

        write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
            false,
        )
        .unwrap();
        // Toggle it off, which records "Reviewer" in the disabled override.
        set_enabled(SubagentScope::Project, Some(p), "Reviewer", false).unwrap();
        let before: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(before["disabled"], json!(["Reviewer"]));

        // Deleting the type must also purge its override so a future same-named
        // type does not inherit the stale off state.
        delete_subagent(SubagentScope::Project, Some(p), "Reviewer").unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert!(after.get("disabled").is_none());

        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn write_subagent_always_serializes_tools_key_even_when_empty() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-empty-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        let mut def = sample_def("no-tools");
        def.tools = vec![];
        write_subagent(SubagentScope::Project, Some(p), &def, false).unwrap();
        let md =
            std::fs::read_to_string(proj.join(".hoy").join("agents").join("no-tools.md")).unwrap();
        // An explicit empty list (zero tools), never an omitted key that the registry
        // would read as full access.
        assert!(md.contains("tools: []"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn overwrite_rejects_a_builtin_shadow_name() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-shadow-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        // Simulate a hand-authored shadow file the create path could never make.
        let dir = proj.join(".hoy").join("agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Explore.md"), "---\n---\nhand authored\n").unwrap();
        // Overwrite must still refuse to rewrite a built-in-named file.
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Explore"),
            true
        )
        .is_err());
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn delete_preserves_a_builtin_override() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-bi-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        let json_path = proj.join(".hoy").join("subagents.json");
        // The user disabled the built-in "explore" (no .md file involved).
        set_enabled(SubagentScope::Project, Some(p), "explore", false).unwrap();
        // Deleting a same-named file (none here) must NOT wipe the built-in's
        // override, or it would silently re-enable a built-in the user turned off.
        delete_subagent(SubagentScope::Project, Some(p), "explore").unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(after["disabled"], json!(["explore"]));
        std::fs::remove_dir_all(&proj).ok();
    }
}
