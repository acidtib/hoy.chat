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

// HOY-368: agent overrides live in the `hoy.agents` section of settings.json,
// the same file pi uses for its own settings (pi re-reads it and writes back
// only the fields it changed, so the section survives). The legacy
// subagents.json is read as a fallback and removed on the next write.
const SETTINGS_FILE: &str = "settings.json";
const LEGACY_FILE: &str = "subagents.json";

fn global_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join(SETTINGS_FILE))
}

fn project_path(project: &str) -> Result<PathBuf, String> {
    if project.trim().is_empty() {
        return Err("project path is required for project scope".to_string());
    }
    Ok(PathBuf::from(project)
        .join(PROJECT_CONFIG_DIR)
        .join(SETTINGS_FILE))
}

fn path_for(scope: SubagentScope, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        SubagentScope::Global => global_path(),
        SubagentScope::Project => project_path(project.unwrap_or("")),
    }
}

fn legacy_path(settings: &Path) -> PathBuf {
    settings.with_file_name(LEGACY_FILE)
}

// The whole settings file. Missing or empty -> empty object; unparseable ->
// Err, so a broken pi settings file is never overwritten.
fn read_settings_at(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(Map::new()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(format!(
                "{} is not a JSON object; fix it before changing agents",
                path.display()
            )),
        },
        Err(_) => Ok(Map::new()),
    }
}

fn agents_section(settings: &Map<String, Value>) -> Option<Map<String, Value>> {
    match settings.get("hoy").and_then(|h| h.get("agents")) {
        Some(Value::Object(m)) => Some(m.clone()),
        _ => None,
    }
}

// The agent overrides at `path` (a settings.json): its hoy.agents section, else
// the legacy subagents.json beside it. Never errors: a bad file must not block
// the settings page from loading the other scope.
fn read_config_at(path: &Path) -> Map<String, Value> {
    if let Some(section) = read_settings_at(path)
        .ok()
        .as_ref()
        .and_then(agents_section)
    {
        return section;
    }
    match std::fs::read(legacy_path(path)) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        Err(_) => Map::new(),
    }
}

// pi guards settings.json with proper-lockfile: a `<file>.lock` directory,
// created atomically with mkdir, treated as stale once its mtime is 10s old.
// Taking the same lock keeps a pi write and a Hoy write from interleaving.
const LOCK_STALE: std::time::Duration = std::time::Duration::from_secs(10);
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

struct SettingsLock(PathBuf);

impl Drop for SettingsLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn lock_settings(path: &Path, wait: std::time::Duration) -> Result<SettingsLock, String> {
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let start = std::time::Instant::now();
    loop {
        match std::fs::create_dir(&lock) {
            Ok(()) => return Ok(SettingsLock(lock)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .map(|t| t.elapsed().unwrap_or_default() > LOCK_STALE)
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_dir(&lock);
                    continue;
                }
                if start.elapsed() > wait {
                    return Err(format!(
                        "{} is locked by another writer; try again",
                        path.display()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => return Err(format!("lock {}: {e}", lock.display())),
        }
    }
}

// Store `agents` as hoy.agents in the settings file, keeping every other key,
// then drop the legacy subagents.json whose contents the caller migrated.
fn write_config_atomic_at(path: &Path, agents: &Map<String, Value>) -> Result<(), String> {
    write_config_locked_at(path, agents, LOCK_WAIT)
}

fn write_config_locked_at(
    path: &Path,
    agents: &Map<String, Value>,
    wait: std::time::Duration,
) -> Result<(), String> {
    let dir = path.parent().ok_or("settings.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _lock = lock_settings(path, wait)?;
    let mut settings = read_settings_at(path)?;
    let mut hoy = match settings.remove("hoy") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    if agents.is_empty() {
        hoy.remove("agents");
    } else {
        hoy.insert("agents".to_string(), Value::Object(agents.clone()));
    }
    if !hoy.is_empty() {
        settings.insert("hoy".to_string(), Value::Object(hoy));
    }
    write_file_atomic_at(path, &settings)?;
    let _ = std::fs::remove_file(legacy_path(path));
    Ok(())
}

fn write_file_atomic_at(path: &Path, config: &Map<String, Value>) -> Result<(), String> {
    let dir = path.parent().ok_or("settings.json path has no parent")?;

    let mut body = serde_json::to_vec_pretty(&Value::Object(config.clone()))
        .map_err(|e| format!("serialize settings.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("settings.json.tmp-hoy-{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        f.write_all(&body)
            .and_then(|_| f.flush())
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    // Keep the existing file's mode (pi's settings.json is not a secret file).
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
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

// Store an empty list as an absent key so the agents section stays minimal.
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
// ships `enabled: false` in its.md frontmatter.
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

// HOY-368: set several agents on or off in one write, so choosing a project's
// fleet is one file change and one respawn.
fn set_many_enabled_at(path: &Path, changes: &[(String, bool)]) -> Result<(), String> {
    let _guard = SUBAGENTS_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    mutate_override_locked(path, |enabled_list, disabled_list| {
        let mut changed = false;
        for (name, on) in changes {
            let (add, remove) = if *on {
                (&mut *enabled_list, &mut *disabled_list)
            } else {
                (&mut *disabled_list, &mut *enabled_list)
            };
            changed |= ensure_present(add, name);
            changed |= ensure_absent(remove, name);
        }
        changed
    })
}

pub fn set_many_enabled(
    scope: SubagentScope,
    project: Option<&str>,
    changes: &[(String, bool)],
) -> Result<(), String> {
    if changes.iter().any(|(n, _)| n.trim().is_empty()) {
        return Err("subagent name is required".to_string());
    }
    set_many_enabled_at(&path_for(scope, project)?, changes)
}

// A per-agent model override under `models` ({name: "provider/id"}). None
// clears it so the agent falls back to its own default.
fn set_model_at(path: &Path, name: &str, model: Option<&str>) -> Result<(), String> {
    let _guard = SUBAGENTS_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut config = read_config_at(path);
    let mut models = match config.remove("models") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            models.insert(name.to_string(), Value::String(m.to_string()));
        }
        None => {
            models.remove(name);
        }
    }
    if !models.is_empty() {
        config.insert("models".to_string(), Value::Object(models));
    }
    write_config_atomic_at(path, &config)
}

pub fn set_model(
    scope: SubagentScope,
    project: Option<&str>,
    name: &str,
    model: Option<&str>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("subagent name is required".to_string());
    }
    set_model_at(&path_for(scope, project)?, name.trim(), model)
}

// Whether the project already carries a fleet choice, for example one
// committed by a teammate.
pub fn project_has_fleet(project: &str) -> bool {
    project_path(project)
        .map(|p| {
            read_settings_at(&p)
                .ok()
                .as_ref()
                .and_then(agents_section)
                .is_some()
                || legacy_path(&p).exists()
        })
        .unwrap_or(false)
}

// HOY-254 (Slice 1): the write path for custom subagent types. Rust serializes a
// type into a `<scope>/agents/<name>.md` (global agent dir or <project>/.hoy/
// agents). The sidecar's hoy-agents-registry.ts is the single READER. This is the
// single-parser invariant: because Rust only ever SERIALIZES and never parses a
// .md, the two sides can never drift on precedence, tool validation, or defaults.

// The built-in type names (hoy-agents-registry.ts BUILTIN_SUBAGENTS), lowercased.
// A custom.md must not reuse one of these case-insensitively: the registry keys
// types by name, so a file named e.g. Coder.md will shadow the built-in. Rust
// rejects the write so a built-in can never be masked by a user file.
const BUILTIN_NAMES: [&str; 10] = [
    "researcher",
    "architect",
    "coder",
    "tester",
    "reviewer",
    "writer",
    "project manager",
    "security reviewer",
    "devops",
    "frontend",
];

// The fields a custom type carries, deserialized from the write command's `def`
// arg (camelCase from the renderer). Mirrors SubagentDef/SubagentWrite on the TS
// side. `enabled` is absent by design: a new type is enabled by default and the
// on/off state is owned by the two-sided override in settings.json hoy.agents (set_enabled),
// not the.md. The Option is kept so a caller CAN ship a type disabled, but the
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

// The agents dir a scope's.md files live in: <agent_dir>/agents for global,
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
// dir or shadow another file. "coder" (a built-in) is a valid slug, so the
// built-in check below is separate.
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
// through the strict validate_name. This only gates operations on files that
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

// Serialize a custom type to its.md text: a YAML frontmatter block carrying ONLY
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
    // prompt_mode is a tiny required selector (replace|append). Written always so
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
    // disabled type needs the key. Writing `enabled: true` will be redundant.
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

// Atomic replace for a subagent.md, tmp-then-rename so a crash mid-write never
// leaves a half-written file the sidecar will try to parse. Mirrors
// write_config_atomic_at. 0600/0700 for the same reason (the body is user content
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
// single rename (write_md_atomic_at), no delete-then-write window that can lose
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
        // the write command must never help maintain a shadow of a built-in.
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

// Remove a custom type's.md. Idempotent (a missing file is not an error), same
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
    // future same-named type, but ONLY for a custom name. A built-in-named override
    // belongs to the built-in (whose file, if any, was a shadow), so wiping it
    // will silently re-enable a built-in the user disabled. Best-effort: the file is
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

    #[test]
    fn set_many_enabled_writes_both_lists_in_one_pass() {
        let dir = std::env::temp_dir().join(format!("hoy-fleet-many-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        set_enabled_at(&path, "Coder", false).unwrap();
        set_many_enabled_at(
            &path,
            &[
                ("Coder".into(), true),
                ("Tester".into(), false),
                ("DevOps".into(), true),
            ],
        )
        .unwrap();
        let config = read_config_at(&path);
        assert_eq!(name_vec(&config, "enabled"), vec!["Coder", "DevOps"]);
        assert_eq!(name_vec(&config, "disabled"), vec!["Tester"]);
    }

    #[test]
    fn legacy_subagents_json_migrates_into_settings_on_write() {
        let dir = std::env::temp_dir().join(format!("hoy-fleet-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(dir.join("subagents.json"), br#"{"disabled":["Coder"]}"#).unwrap();
        assert_eq!(name_vec(&read_config_at(&path), "disabled"), vec!["Coder"]);
        set_enabled_at(&path, "Tester", false).unwrap();
        assert_eq!(
            name_vec(&read_config_at(&path), "disabled"),
            vec!["Coder", "Tester"]
        );
        assert!(!dir.join("subagents.json").exists());
    }

    #[test]
    fn a_held_settings_lock_blocks_the_write_and_a_stale_one_is_cleared() {
        let dir = std::env::temp_dir().join(format!("hoy-fleet-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let lock = dir.join("settings.json.lock");
        let mut agents = Map::new();
        agents.insert("disabled".into(), json!(["Coder"]));

        // A live lock (fresh mtime) held by pi: the write waits, then gives up untouched.
        std::fs::create_dir(&lock).unwrap();
        let err = write_config_locked_at(&path, &agents, std::time::Duration::from_millis(100))
            .unwrap_err();
        assert!(err.contains("locked"));
        assert!(!path.exists());

        // The same lock left behind by a crashed writer: stale after 10s, so cleared.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        write_config_locked_at(&path, &agents, std::time::Duration::from_millis(100)).unwrap();
        assert_eq!(name_vec(&read_config_at(&path), "disabled"), vec!["Coder"]);
        assert!(!lock.exists());
    }

    #[test]
    fn a_broken_settings_file_is_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("hoy-fleet-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(set_enabled_at(&path, "Coder", false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn set_model_adds_and_clears_without_touching_other_keys() {
        let dir = std::env::temp_dir().join(format!("hoy-fleet-model-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        set_enabled_at(&path, "Coder", false).unwrap();
        set_model_at(&path, "Researcher", Some("anthropic/claude-haiku")).unwrap();
        let config = read_config_at(&path);
        assert_eq!(config["models"]["Researcher"], "anthropic/claude-haiku");
        assert_eq!(name_vec(&config, "disabled"), vec!["Coder"]);
        set_model_at(&path, "Researcher", None).unwrap();
        let config = read_config_at(&path);
        assert!(config.get("models").is_none());
        assert_eq!(name_vec(&config, "disabled"), vec!["Coder"]);
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn disable_then_enable_round_trips_and_preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("hoy-sub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // pi's own keys and an unknown hoy key must survive the read-modify-write.
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({ "defaultModel": "m", "hoy": { "note": "keep", "agents": { "disabled": [] } } }))
                .unwrap(),
        )
        .unwrap();

        set_enabled_at(&path, "Auditor", false).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["defaultModel"], "m");
        assert_eq!(after["hoy"]["note"], "keep");
        assert_eq!(after["hoy"]["agents"]["disabled"], json!(["Auditor"]));
        // An empty list is stored as an absent key, not `[]`.
        assert!(after["hoy"]["agents"].get("enabled").is_none());

        set_enabled_at(&path, "Auditor", true).unwrap();
        let after2: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Enabling moves the name from disabled to enabled (two-sided override),
        // so a frontmatter-disabled type can be forced on from the settings toggle.
        assert!(after2["hoy"]["agents"].get("disabled").is_none());
        assert_eq!(after2["hoy"]["agents"]["enabled"], json!(["Auditor"]));
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
            body: "You are an auditor.".to_string(),
        }
    }

    #[test]
    fn write_subagent_serializes_expected_frontmatter_and_omits_unset() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-write-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        write_subagent(
            SubagentScope::Project,
            Some(proj.to_str().unwrap()),
            &sample_def("Auditor"),
            false,
        )
        .unwrap();
        let md =
            std::fs::read_to_string(proj.join(".hoy").join("agents").join("Auditor.md")).unwrap();

        // The keys the sidecar parser reads, with the values as set.
        assert!(md.contains("description: \"A red-team reviewer: finds bugs.\""));
        assert!(md.contains("tools: [\"read\", \"grep\"]"));
        assert!(md.contains("prompt_mode: \"append\""));
        assert!(md.contains("model: \"sonnet\""));
        assert!(md.contains("inherit_context: true"));
        assert!(md.contains("max_turns: 5"));
        // Body follows the closing delimiter.
        assert!(md.trim_end().ends_with("You are an auditor."));
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
        assert!(
            write_subagent(SubagentScope::Project, Some(p), &sample_def("coder"), false).is_err()
        );
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Researcher"),
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

        // A fresh name writes. The same name again is a duplicate (create-only).
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Auditor"),
            false
        )
        .is_ok());
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Auditor"),
            false
        )
        .is_err());

        // delete_subagent removes the file and is idempotent.
        delete_subagent(SubagentScope::Project, Some(p), "Auditor").unwrap();
        assert!(!proj.join(".hoy").join("agents").join("Auditor.md").exists());
        delete_subagent(SubagentScope::Project, Some(p), "Auditor").unwrap();

        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn overwrite_replaces_in_place_and_refuses_to_create() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-ow-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        let md_path = proj.join(".hoy").join("agents").join("Auditor.md");

        // overwrite=true on a name with no file is rejected (edit must not create).
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Auditor"),
            true
        )
        .is_err());

        // Create, then overwrite in place: a single atomic write, no delete needed.
        write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Auditor"),
            false,
        )
        .unwrap();
        let mut edited = sample_def("Auditor");
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
        let json_path = proj.join(".hoy").join("settings.json");

        write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Auditor"),
            false,
        )
        .unwrap();
        // Toggle it off, which records "Auditor" in the disabled override.
        set_enabled(SubagentScope::Project, Some(p), "Auditor", false).unwrap();
        let before: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(before["hoy"]["agents"]["disabled"], json!(["Auditor"]));

        // Deleting the type must also purge its override so a future same-named
        // type does not inherit the stale off state.
        delete_subagent(SubagentScope::Project, Some(p), "Auditor").unwrap();
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
        // will read as full access.
        assert!(md.contains("tools: []"));
        std::fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn overwrite_rejects_a_builtin_shadow_name() {
        let proj = std::env::temp_dir().join(format!("hoy-agent-shadow-{}", std::process::id()));
        std::fs::remove_dir_all(&proj).ok();
        let p = proj.to_str().unwrap();
        // Simulate a hand-authored shadow file the create path can never make.
        let dir = proj.join(".hoy").join("agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Reviewer.md"), "---\n---\nhand authored\n").unwrap();
        // Overwrite must still refuse to rewrite a built-in-named file.
        assert!(write_subagent(
            SubagentScope::Project,
            Some(p),
            &sample_def("Reviewer"),
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
        let json_path = proj.join(".hoy").join("settings.json");
        // The user disabled the built-in "Writer" (no.md file involved).
        set_enabled(SubagentScope::Project, Some(p), "Writer", false).unwrap();
        // Deleting a same-named file (none here) must NOT wipe the built-in's
        // override, or it will silently re-enable a built-in the user turned off.
        delete_subagent(SubagentScope::Project, Some(p), "Writer").unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(after["hoy"]["agents"]["disabled"], json!(["Writer"]));
        std::fs::remove_dir_all(&proj).ok();
    }
}
