// Drives Pi's credential store (auth.json) instead of inventing a parallel secret
// store. Rationale: Pi's RPC has no auth command, and Pi's getApiKey resolves
// auth.json (api_key entries) above environment variables, so writing the file is
// the authoritative way to configure a provider from the GUI. We only ever write
// or remove {type:"api_key"} entries; OAuth entries (written by a `pi`/Hoy login)
// are read-modify-write preserved untouched. Key values never leave Rust: the
// renderer receives only configured/not-configured status.
//
// Branded, isolated dir: Hoy uses ~/.hoy/agent, NOT ~/.pi, so it never touches a
// user's stock pi install. Rust writes auth.json here; the sidecar reads the same
// dir because sidecar.rs passes it as PI_CODING_AGENT_DIR (the env our SDK entry
// honors). Override with HOY_AGENT_DIR (tests / power users).
//
// Schema (verified against pi-coding-agent 0.78.0 core/auth-storage.d.ts):
//   auth.json = Record<provider, {type:"api_key", key} | {type:"oauth", ...tokens}>

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

const ENV_AGENT_DIR: &str = "HOY_AGENT_DIR";

// Auth status surfaced to the renderer. Never carries a key value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuth {
    pub provider: String,
    pub configured: bool,
    // "api_key" | "oauth" | "unknown" | null
    pub kind: Option<String>,
    // "authFile" | "environment" | null
    pub source: Option<String>,
    // Only api_key entries in auth.json may be removed from the GUI; OAuth logins
    // are left to Pi so we never strip a user's `pi` session.
    pub removable: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .filter(|h| !h.is_empty())
                .map(PathBuf::from)
        })
}

pub fn agent_dir() -> Result<PathBuf, String> {
    agent_dir_from(
        std::env::var_os(ENV_AGENT_DIR)
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
        home_dir(),
    )
}

// Pure resolution split out so the branded-path logic is testable without
// mutating process env. HOY_AGENT_DIR override wins; otherwise <home>/.hoy/agent.
fn agent_dir_from(override_dir: Option<PathBuf>, home: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(dir) = override_dir.filter(|d| !d.as_os_str().is_empty()) {
        return Ok(dir);
    }
    home.map(|h| h.join(".hoy").join("agent"))
        .ok_or_else(|| "cannot resolve home directory".to_string())
}

fn auth_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("auth.json"))
}

struct ProviderDef {
    id: &'static str,
    label: &'static str,
    env: &'static str,
}

// API-key providers Pi supports, from pi-coding-agent 0.78.0
// core/provider-display-names.js (BUILT_IN_PROVIDER_DISPLAY_NAMES). Excludes
// amazon-bedrock and google-vertex, which use cloud auth (AWS creds / gcloud ADC)
// rather than a plain api_key entry. `env` is Pi's actual env var for that
// provider; several differ from the id (google -> GEMINI_API_KEY). Pinned to the
// Pi version: re-verify against provider-display-names.js when bumping Pi.
const PROVIDERS: &[ProviderDef] = &[
    ProviderDef { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY" },
    ProviderDef { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY" },
    ProviderDef { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY" },
    ProviderDef { id: "google", label: "Google Gemini", env: "GEMINI_API_KEY" },
    ProviderDef { id: "groq", label: "Groq", env: "GROQ_API_KEY" },
    ProviderDef { id: "xai", label: "xAI", env: "XAI_API_KEY" },
    ProviderDef { id: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY" },
    ProviderDef { id: "mistral", label: "Mistral", env: "MISTRAL_API_KEY" },
    ProviderDef { id: "cerebras", label: "Cerebras", env: "CEREBRAS_API_KEY" },
    ProviderDef { id: "fireworks", label: "Fireworks", env: "FIREWORKS_API_KEY" },
    ProviderDef { id: "together", label: "Together AI", env: "TOGETHER_API_KEY" },
    ProviderDef { id: "huggingface", label: "Hugging Face", env: "HF_TOKEN" },
    ProviderDef { id: "azure-openai-responses", label: "Azure OpenAI Responses", env: "AZURE_OPENAI_API_KEY" },
    ProviderDef { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", env: "CLOUDFLARE_API_KEY" },
    ProviderDef { id: "cloudflare-workers-ai", label: "Cloudflare Workers AI", env: "CLOUDFLARE_API_KEY" },
    ProviderDef { id: "vercel-ai-gateway", label: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY" },
    ProviderDef { id: "moonshotai", label: "Moonshot AI", env: "MOONSHOT_API_KEY" },
    ProviderDef { id: "moonshotai-cn", label: "Moonshot AI (China)", env: "MOONSHOT_CN_API_KEY" },
    ProviderDef { id: "kimi-coding", label: "Kimi For Coding", env: "KIMI_API_KEY" },
    ProviderDef { id: "minimax", label: "MiniMax", env: "MINIMAX_API_KEY" },
    ProviderDef { id: "minimax-cn", label: "MiniMax (China)", env: "MINIMAX_CN_API_KEY" },
    ProviderDef { id: "zai", label: "ZAI", env: "ZAI_API_KEY" },
    ProviderDef { id: "opencode", label: "OpenCode Zen", env: "OPENCODE_API_KEY" },
    ProviderDef { id: "opencode-go", label: "OpenCode Go", env: "OPENCODE_API_KEY" },
    ProviderDef { id: "xiaomi", label: "Xiaomi MiMo", env: "XIAOMI_API_KEY" },
    ProviderDef { id: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token Plan (China)", env: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
    ProviderDef { id: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token Plan (Amsterdam)", env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
    ProviderDef { id: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token Plan (Singapore)", env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    // Env var Pi reads for this provider's key, shown in settings as the
    // alternative to storing a key in auth.json.
    pub env: String,
}

// Full provider list for the settings picker. get_available_models is gated to
// configured providers, so this is what lets a user configure their first key.
pub fn supported_providers() -> Vec<ProviderInfo> {
    PROVIDERS
        .iter()
        .map(|p| ProviderInfo {
            id: p.id.to_string(),
            label: p.label.to_string(),
            env: p.env.to_string(),
        })
        .collect()
}

// Env var Pi reads for a provider key. Known providers use Pi's actual name (some
// differ from the id); unknown ids fall back to the uppercase convention. Used
// only for the "configured via environment" status signal.
fn env_var_for(provider: &str) -> String {
    if let Some(def) = PROVIDERS.iter().find(|p| p.id == provider) {
        return def.env.to_string();
    }
    let up: String = provider
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{up}_API_KEY")
}

fn read_auth_map_at(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Map::new()),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err("auth.json is not a JSON object".to_string()),
            Err(e) => Err(format!("parse auth.json: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("read auth.json: {e}")),
    }
}

fn write_auth_map_atomic_at(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    let dir = path.parent().ok_or("auth.json path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }

    let mut body = serde_json::to_vec_pretty(&Value::Object(map.clone()))
        .map_err(|e| format!("serialize auth.json: {e}"))?;
    body.push(b'\n');

    let tmp = dir.join(format!("auth.json.tmp-{}", std::process::id()));
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

fn set_api_key_at(path: &Path, provider: &str, key: &str) -> Result<(), String> {
    let mut map = read_auth_map_at(path)?;
    let mut entry = Map::new();
    entry.insert("type".to_string(), Value::String("api_key".to_string()));
    entry.insert("key".to_string(), Value::String(key.to_string()));
    map.insert(provider.to_string(), Value::Object(entry));
    write_auth_map_atomic_at(path, &map)
}

fn remove_provider_at(path: &Path, provider: &str) -> Result<(), String> {
    let mut map = read_auth_map_at(path)?;
    if map.remove(provider).is_none() {
        return Ok(());
    }
    write_auth_map_atomic_at(path, &map)
}

pub fn set_api_key(provider: &str, key: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider is required".to_string());
    }
    if key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    set_api_key_at(&auth_path()?, provider, key.trim())
}

pub fn remove_provider(provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider is required".to_string());
    }
    remove_provider_at(&auth_path()?, provider)
}

pub fn statuses(providers: &[String]) -> Result<Vec<ProviderAuth>, String> {
    let map = read_auth_map_at(&auth_path()?)?;
    Ok(providers
        .iter()
        .map(|provider| {
            if let Some(entry) = map.get(provider) {
                let kind = entry
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let removable = kind == "api_key";
                return ProviderAuth {
                    provider: provider.clone(),
                    configured: true,
                    kind: Some(kind),
                    source: Some("authFile".to_string()),
                    removable,
                };
            }
            if std::env::var_os(env_var_for(provider)).is_some() {
                return ProviderAuth {
                    provider: provider.clone(),
                    configured: true,
                    kind: Some("api_key".to_string()),
                    source: Some("environment".to_string()),
                    removable: false,
                };
            }
            ProviderAuth {
                provider: provider.clone(),
                configured: false,
                kind: None,
                source: None,
                removable: false,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_auth_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hoy-desktop-test-{}-{}-{}",
            std::process::id(),
            tag,
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        dir.join("auth.json")
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    #[test]
    fn writes_api_key_entry_with_exact_schema() {
        let path = temp_auth_path("schema");
        set_api_key_at(&path, "openrouter", "sk-test-123").unwrap();
        let map = read_auth_map_at(&path).unwrap();
        let entry = map.get("openrouter").unwrap();
        assert_eq!(entry["type"], "api_key");
        assert_eq!(entry["key"], "sk-test-123");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn preserves_existing_oauth_entry_when_adding_api_key() {
        let path = temp_auth_path("preserve");
        // Seed an OAuth entry like `pi` login would write.
        let mut seed = Map::new();
        let mut oauth = Map::new();
        oauth.insert("type".into(), Value::String("oauth".into()));
        oauth.insert("access".into(), Value::String("tok-abc".into()));
        oauth.insert("refresh".into(), Value::String("ref-xyz".into()));
        oauth.insert("expires".into(), Value::from(123456u64));
        seed.insert("anthropic".into(), Value::Object(oauth));
        write_auth_map_atomic_at(&path, &seed).unwrap();

        set_api_key_at(&path, "openrouter", "sk-new").unwrap();

        let map = read_auth_map_at(&path).unwrap();
        assert_eq!(map["anthropic"]["type"], "oauth");
        assert_eq!(map["anthropic"]["access"], "tok-abc");
        assert_eq!(map["anthropic"]["refresh"], "ref-xyz");
        assert_eq!(map["openrouter"]["type"], "api_key");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_drops_only_the_named_provider() {
        let path = temp_auth_path("remove");
        set_api_key_at(&path, "openrouter", "sk-a").unwrap();
        set_api_key_at(&path, "openai", "sk-b").unwrap();
        remove_provider_at(&path, "openrouter").unwrap();
        let map = read_auth_map_at(&path).unwrap();
        assert!(!map.contains_key("openrouter"));
        assert_eq!(map["openai"]["key"], "sk-b");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let path = temp_auth_path("missing");
        assert!(read_auth_map_at(&path).unwrap().is_empty());
    }

    #[test]
    fn env_var_uses_pi_names_then_falls_back() {
        assert_eq!(env_var_for("anthropic"), "ANTHROPIC_API_KEY");
        // Differs from the id: google -> GEMINI, vercel-ai-gateway -> AI_GATEWAY.
        assert_eq!(env_var_for("google"), "GEMINI_API_KEY");
        assert_eq!(env_var_for("vercel-ai-gateway"), "AI_GATEWAY_API_KEY");
        // Unknown id falls back to the uppercase convention.
        assert_eq!(env_var_for("totally-unknown"), "TOTALLY_UNKNOWN_API_KEY");
    }

    #[test]
    fn agent_dir_defaults_to_branded_hoy_dir() {
        let resolved = agent_dir_from(None, Some(PathBuf::from("/home/u"))).unwrap();
        assert_eq!(resolved, PathBuf::from("/home/u/.hoy/agent"));
    }

    #[test]
    fn agent_dir_override_wins_and_empty_is_ignored() {
        let overridden =
            agent_dir_from(Some(PathBuf::from("/custom/dir")), Some(PathBuf::from("/home/u")))
                .unwrap();
        assert_eq!(overridden, PathBuf::from("/custom/dir"));

        let empty_ignored =
            agent_dir_from(Some(PathBuf::new()), Some(PathBuf::from("/home/u"))).unwrap();
        assert_eq!(empty_ignored, PathBuf::from("/home/u/.hoy/agent"));
    }

    #[test]
    fn agent_dir_errors_without_home() {
        assert!(agent_dir_from(None, None).is_err());
    }

    #[test]
    fn supported_providers_are_unique_and_nonempty() {
        let list = supported_providers();
        assert!(list.len() >= 20);
        let mut ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "provider ids must be unique");
        for p in &list {
            assert!(!p.env.is_empty(), "provider {} must have an env var", p.id);
        }
        let google = list.iter().find(|p| p.id == "google").unwrap();
        assert_eq!(google.env, "GEMINI_API_KEY");
    }
}
