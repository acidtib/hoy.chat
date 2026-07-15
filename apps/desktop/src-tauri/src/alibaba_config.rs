use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::pi_config::agent_dir;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

const PROVIDERS: &[(&str, &str, &str)] = &[
    (
        "alibaba-cloud",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    ),
    (
        "alibaba-coding-plan",
        "https://coding-intl.dashscope.aliyuncs.com/v1",
        "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
    ),
    (
        "alibaba-token-plan",
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EndpointPair {
    open_ai_base_url: String,
    anthropic_base_url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProviderConfig {
    #[serde(default)]
    providers: BTreeMap<String, ProviderEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderEntry {
    endpoints: StoredEndpoints,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEndpoints {
    openai: String,
    anthropic: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LegacyAlibabaConfig {
    #[serde(default)]
    providers: BTreeMap<String, EndpointPair>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlibabaEndpointSettings {
    provider: String,
    open_ai_base_url: String,
    anthropic_base_url: String,
    using_defaults: bool,
}

fn config_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("providers.json"))
}

fn defaults(provider: &str) -> Option<EndpointPair> {
    PROVIDERS
        .iter()
        .find(|item| item.0 == provider)
        .map(|item| EndpointPair {
            open_ai_base_url: item.1.to_string(),
            anthropic_base_url: item.2.to_string(),
        })
}

fn read_at(path: &Path) -> ProviderConfig {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(config) => config,
            Err(e) => {
                eprintln!(
                    "[hoy-desktop] provider config unreadable ({}): reverting to defaults — {e}",
                    path.display()
                );
                ProviderConfig::default()
            }
        },
        Err(_) => ProviderConfig::default(),
    }
}

fn write_json_at<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let dir = path.parent().ok_or("provider data path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut body = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {e}", path.display()))?;
    body.push(b'\n');
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("providers");
    let tmp = dir.join(format!("{file_name}.tmp-{}", std::process::id()));
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        file.write_all(&body)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

fn write_at(path: &Path, config: &ProviderConfig) -> Result<(), String> {
    write_json_at(path, config)
}

fn normalize_url(value: &str) -> Result<String, String> {
    let mut url =
        tauri::Url::parse(value.trim()).map_err(|_| "endpoint must be a valid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("endpoint must use HTTPS".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("endpoint must not contain credentials".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("endpoint must not contain a query or fragment".to_string());
    }
    if url.host_str().is_none() {
        return Err("endpoint must include a host".to_string());
    }
    let trimmed = url.path().trim_end_matches('/').to_string();
    url.set_path(if trimmed.is_empty() { "/" } else { &trimmed });
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn list_at(path: &Path) -> Vec<AlibabaEndpointSettings> {
    let config = read_at(path);
    PROVIDERS
        .iter()
        .map(|item| {
            let provider = item.0;
            let custom = config.providers.get(provider).map(|entry| EndpointPair {
                open_ai_base_url: entry.endpoints.openai.clone(),
                anthropic_base_url: entry.endpoints.anthropic.clone(),
            });
            let pair = custom
                .clone()
                .unwrap_or_else(|| defaults(provider).unwrap());
            AlibabaEndpointSettings {
                provider: provider.to_string(),
                open_ai_base_url: pair.open_ai_base_url,
                anthropic_base_url: pair.anthropic_base_url,
                using_defaults: custom.is_none(),
            }
        })
        .collect()
}

pub fn list() -> Result<Vec<AlibabaEndpointSettings>, String> {
    Ok(list_at(&config_path()?))
}

fn save_at(path: &Path, provider: &str, open_ai: &str, anthropic: &str) -> Result<(), String> {
    if defaults(provider).is_none() {
        return Err("unsupported Alibaba provider".to_string());
    }
    let pair = EndpointPair {
        open_ai_base_url: normalize_url(open_ai)?,
        anthropic_base_url: normalize_url(anthropic)?,
    };
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut config = read_at(path);
    config.providers.insert(
        provider.to_string(),
        ProviderEntry {
            endpoints: StoredEndpoints {
                openai: pair.open_ai_base_url,
                anthropic: pair.anthropic_base_url,
            },
        },
    );
    write_at(path, &config)
}

pub fn save(provider: &str, open_ai: &str, anthropic: &str) -> Result<(), String> {
    save_at(&config_path()?, provider, open_ai, anthropic)
}

fn reset_at(path: &Path, provider: &str) -> Result<(), String> {
    if defaults(provider).is_none() {
        return Err("unsupported Alibaba provider".to_string());
    }
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut config = read_at(path);
    config.providers.remove(provider);
    write_at(path, &config)
}

pub fn reset(provider: &str) -> Result<(), String> {
    reset_at(&config_path()?, provider)
}

pub fn migrate_legacy_files() {
    let Ok(dir) = agent_dir() else { return };
    if let Err(error) = migrate_legacy_files_at(&dir) {
        eprintln!(
            "[hoy-desktop] provider data migration ({}): {error}",
            dir.display()
        );
    }
}

fn migrate_legacy_files_at(dir: &Path) -> Result<(), String> {
    let legacy_config_path = dir.join("alibaba.json");
    let config_path = dir.join("providers.json");
    if !config_path.exists() && legacy_config_path.exists() {
        let bytes = std::fs::read(&legacy_config_path)
            .map_err(|e| format!("read {}: {e}", legacy_config_path.display()))?;
        let legacy: LegacyAlibabaConfig = serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse {}: {e}", legacy_config_path.display()))?;
        let config = ProviderConfig {
            providers: legacy
                .providers
                .into_iter()
                .map(|(provider, endpoints)| {
                    (
                        provider,
                        ProviderEntry {
                            endpoints: StoredEndpoints {
                                openai: endpoints.open_ai_base_url,
                                anthropic: endpoints.anthropic_base_url,
                            },
                        },
                    )
                })
                .collect(),
        };
        write_json_at(&config_path, &config)?;
        std::fs::remove_file(&legacy_config_path)
            .map_err(|e| format!("remove {}: {e}", legacy_config_path.display()))?;
    }

    let legacy_cache_path = dir.join("alibaba-models-cache.json");
    let cache_path = dir.join("provider-models-cache.json");
    if !cache_path.exists() && legacy_cache_path.exists() {
        let bytes = std::fs::read(&legacy_cache_path)
            .map_err(|e| format!("read {}: {e}", legacy_cache_path.display()))?;
        let mut cache: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse {}: {e}", legacy_cache_path.display()))?;
        if let Some(providers) = cache
            .get_mut("providers")
            .and_then(|value| value.as_object_mut())
        {
            for entry in providers.values_mut() {
                let Some(endpoints) = entry
                    .get_mut("endpoints")
                    .and_then(|value| value.as_object_mut())
                else {
                    continue;
                };
                if let Some(value) = endpoints.remove("openAiBaseUrl") {
                    endpoints.insert("openai".to_string(), value);
                }
                if let Some(value) = endpoints.remove("anthropicBaseUrl") {
                    endpoints.insert("anthropic".to_string(), value);
                }
            }
        }
        write_json_at(&cache_path, &cache)?;
        std::fs::remove_file(&legacy_cache_path)
            .map_err(|e| format!("remove {}: {e}", legacy_cache_path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hoy-alibaba-{tag}-{}.json", std::process::id()))
    }

    #[test]
    fn defaults_then_custom_then_reset() {
        let path = path("roundtrip");
        let _ = std::fs::remove_file(&path);
        assert!(list_at(&path).iter().all(|entry| entry.using_defaults));
        save_at(
            &path,
            "alibaba-cloud",
            "https://example.com/openai/",
            "https://example.com/anthropic/",
        )
        .unwrap();
        let cloud = list_at(&path)
            .into_iter()
            .find(|entry| entry.provider == "alibaba-cloud")
            .unwrap();
        assert!(!cloud.using_defaults);
        assert_eq!(cloud.open_ai_base_url, "https://example.com/openai");
        reset_at(&path, "alibaba-cloud").unwrap();
        assert!(
            list_at(&path)
                .into_iter()
                .find(|entry| entry.provider == "alibaba-cloud")
                .unwrap()
                .using_defaults
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_unsafe_endpoints() {
        let path = path("unsafe");
        for url in [
            "http://example.com/v1",
            "https://user@example.com/v1",
            "https://example.com/v1?q=1",
        ] {
            assert!(save_at(&path, "alibaba-cloud", url, "https://example.com/anthropic").is_err());
        }
        assert!(save_at(
            &path,
            "not-alibaba",
            "https://example.com/a",
            "https://example.com/b"
        )
        .is_err());
    }

    #[test]
    fn writes_shared_provider_schema() {
        let path = path("shared-schema");
        let _ = std::fs::remove_file(&path);
        save_at(
            &path,
            "alibaba-cloud",
            "https://example.com/openai",
            "https://example.com/anthropic",
        )
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            value["providers"]["alibaba-cloud"]["endpoints"]["openai"],
            "https://example.com/openai"
        );
        assert_eq!(
            value["providers"]["alibaba-cloud"]["endpoints"]["anthropic"],
            "https://example.com/anthropic"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn migrates_legacy_provider_files_without_overwriting_shared_files() {
        let dir = std::env::temp_dir().join(format!(
            "hoy-provider-migration-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("alibaba.json"),
            r#"{"providers":{"alibaba-cloud":{"openAiBaseUrl":"https://old.example/v1","anthropicBaseUrl":"https://old.example/anthropic"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("alibaba-models-cache.json"),
            r#"{"providers":{"alibaba-cloud":{"fetchedAt":1,"endpoints":{"openAiBaseUrl":"https://old.example/v1","anthropicBaseUrl":"https://old.example/anthropic"},"models":[]}}}"#,
        )
        .unwrap();

        migrate_legacy_files_at(&dir).unwrap();

        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("providers.json")).unwrap()).unwrap();
        assert_eq!(
            config["providers"]["alibaba-cloud"]["endpoints"]["openai"],
            "https://old.example/v1"
        );
        let cache: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("provider-models-cache.json")).unwrap())
                .unwrap();
        assert_eq!(
            cache["providers"]["alibaba-cloud"]["endpoints"]["anthropic"],
            "https://old.example/anthropic"
        );
        assert!(!dir.join("alibaba.json").exists());
        assert!(!dir.join("alibaba-models-cache.json").exists());

        std::fs::write(dir.join("alibaba.json"), "invalid").unwrap();
        migrate_legacy_files_at(&dir).unwrap();
        assert!(dir.join("alibaba.json").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
