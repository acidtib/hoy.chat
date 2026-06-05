// Frontend-facing contract. Mirror every change here in src/lib/types.ts.
// Field names are camelCase to match the TS side directly.

use serde::{Deserialize, Serialize};

// Streaming event delivered to the renderer over a Tauri Channel. Constructed in
// sidecar.rs::route_message from Pi's raw RPC events; mirrored in lib/types.ts.
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

// Subset of Pi's SessionStats (core/agent-session.d.ts) returned by
// get_session_stats; powers the bottom context bar. Pi sends more fields
// (message counts, sessionId, ...); serde ignores the extras.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    // None right after compaction until the next assistant response: the UI
    // renders a dash rather than zeroes.
    #[serde(default)]
    pub context_usage: Option<ContextUsage>,
    pub tokens: TokenUsage,
    pub cost: f64,
    // Durable path of this session's JSONL on disk (M4). The renderer persists it
    // onto the thread so a reopened thread can reload its transcript. None for an
    // in-memory session.
    #[serde(default)]
    pub session_file: Option<String>,
}

// Pi's ContextUsage. tokens/percent are null until the next LLM response after a
// compaction; contextWindow is always known.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub tokens: Option<u64>,
    pub context_window: u64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
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
