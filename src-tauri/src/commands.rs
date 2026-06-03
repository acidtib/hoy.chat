use tauri::State;

use crate::events::PiState;
use crate::sidecar::SidecarManager;

#[tauri::command]
pub async fn get_state(
    session_id: String,
    manager: State<'_, SidecarManager>,
) -> Result<PiState, String> {
    let process = manager.get(&session_id)?;
    let response = process.request(serde_json::json!({ "type": "get_state" })).await?;

    if response.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
        let message = response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("get_state failed");
        return Err(message.to_string());
    }

    let data = response
        .get("data")
        .cloned()
        .ok_or("get_state response missing data")?;
    serde_json::from_value(data).map_err(|e| format!("decode PiState: {e}"))
}

#[tauri::command]
pub fn active_session_id(manager: State<'_, SidecarManager>) -> Option<String> {
    manager.active_session_id()
}
