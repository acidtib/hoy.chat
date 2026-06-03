// Frontend-facing contract. Mirror every change here in src/lib/types.ts.
// Field names are camelCase to match the TS side directly.

use serde::{Deserialize, Serialize};

// Streaming event delivered to the renderer over a Tauri Channel (wired in M3).
// Defined now so the Rust/TS contract is established from the start; not yet
// constructed, hence the allow.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    Text {
        delta: String,
    },
    Tool {
        phase: ToolPhase,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    Status {
        label: String,
    },
    Error {
        message: String,
    },
    Done,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPhase {
    Start,
    Update,
    End,
}

// Subset of Pi's RpcSessionState (dist/modes/rpc/rpc-types.d.ts) returned by get_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiState {
    #[serde(default)]
    pub model: Option<ModelInfo>,
    pub thinking_level: String,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub session_id: String,
    #[serde(default)]
    pub session_name: Option<String>,
    pub message_count: u64,
    pub pending_message_count: u64,
    pub auto_compaction_enabled: bool,
}

// Pi's Model object. Extra fields are ignored; these are the ones the UI needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning: Option<bool>,
}
