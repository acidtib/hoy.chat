use serde_json::{json, Value};
use tauri::State;

use crate::events::{ModelInfo, PiState};
use crate::pi_config::{self, ProviderAuth};
use crate::sidecar::SidecarManager;

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

// Persist a provider API key into Pi's auth.json, then respawn the active sidecar
// so it reloads credentials. The key value is never returned to the renderer.
#[tauri::command]
pub async fn save_provider_key(
    provider: String,
    key: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    pi_config::set_api_key(&provider, &key)?;
    if let Some(id) = manager.active_session_id() {
        manager.respawn(&id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_provider_key(
    provider: String,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    pi_config::remove_provider(&provider)?;
    if let Some(id) = manager.active_session_id() {
        manager.respawn(&id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn provider_statuses(providers: Vec<String>) -> Result<Vec<ProviderAuth>, String> {
    pi_config::statuses(&providers)
}

#[tauri::command]
pub fn known_providers() -> Vec<String> {
    pi_config::known_providers()
}

#[tauri::command]
pub fn active_session_id(manager: State<'_, SidecarManager>) -> Option<String> {
    manager.active_session_id()
}
