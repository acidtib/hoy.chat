// Typed wrappers around Tauri invoke(). Components call these, never invoke()
// directly. Command names and arg shapes mirror src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentEvent,
  ModelInfo,
  PermissionMode,
  PiState,
  ProviderAuth,
  ProviderInfo,
  SessionStats,
  Workspace,
} from "./types";

// Native directory picker for adding a project. Returns the chosen absolute path,
// or null if the user cancels.
export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export function activeSessionId(): Promise<string | null> {
  return invoke<string | null>("active_session_id");
}

export function getState(sessionId: string): Promise<PiState> {
  return invoke<PiState>("get_state", { sessionId });
}

export function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models");
}

export function setModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  return invoke<void>("set_model", { sessionId, provider, modelId });
}

// The key value is sent down once and never read back; status comes from
// providerStatuses. Pi's auth.json is the store, written in Rust.
export function saveProviderKey(provider: string, key: string): Promise<void> {
  return invoke<void>("save_provider_key", { provider, key });
}

export function removeProviderKey(provider: string): Promise<void> {
  return invoke<void>("remove_provider_key", { provider });
}

export function providerStatuses(providers: string[]): Promise<ProviderAuth[]> {
  return invoke<ProviderAuth[]>("provider_statuses", { providers });
}

export function supportedProviders(): Promise<ProviderInfo[]> {
  return invoke<ProviderInfo[]>("supported_providers");
}

// Spawn a thread's own sidecar in its project dir, returning the sessionId the
// thread then drives. Empty cwd falls back to the backend's default dir.
// `sessionFile` reopens an existing transcript (M4 restore); omit for a new one.
export function createSession(
  cwd: string,
  sessionFile?: string | null,
): Promise<string> {
  return invoke<string>("create_session", { cwd, sessionFile: sessionFile ?? null });
}

// Tear down a thread's sidecar (panel close / delete). The control session is
// never removed by the backend.
export function closeSession(sessionId: string): Promise<void> {
  return invoke<void>("close_session", { sessionId });
}

// Full transcript as raw Pi AgentMessage objects; mapped to turns by the caller.
export function getMessages(sessionId: string): Promise<unknown[]> {
  return invoke<unknown[]>("get_messages", { sessionId });
}

export function deleteSessionFile(sessionFile: string): Promise<void> {
  return invoke<void>("delete_session_file", { sessionFile });
}

export function loadWorkspace(): Promise<Workspace> {
  return invoke<Workspace>("load_workspace");
}

export function saveWorkspace(workspace: Workspace): Promise<void> {
  return invoke<void>("save_workspace", { workspace });
}

// Send a prompt and stream the turn. Resolves once Pi accepts the prompt; tokens,
// tool calls, and the terminal `done` arrive on `onEvent`, never via the return.
export function sendPrompt(
  sessionId: string,
  message: string,
  onEvent: Channel<AgentEvent>,
): Promise<void> {
  return invoke<void>("send_prompt", { sessionId, message, onEvent });
}

export function getSessionStats(sessionId: string): Promise<SessionStats> {
  return invoke<SessionStats>("get_session_stats", { sessionId });
}

export function abort(sessionId: string): Promise<void> {
  return invoke<void>("abort", { sessionId });
}

// Switch a session's permission mode (HOY-186). Applies immediately, even
// mid-stream; the backend also remembers it for respawns.
export function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  return invoke<void>("set_permission_mode", { sessionId, mode });
}

// Answer a pending approval card. `value` answers a select dialog, `confirmed`
// a confirm dialog, `cancelled` declines either; exactly one should be set.
export function respondPermission(
  sessionId: string,
  requestId: string,
  answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<void> {
  return invoke<void>("respond_permission", {
    sessionId,
    requestId,
    value: answer.value ?? null,
    confirmed: answer.confirmed ?? null,
    cancelled: answer.cancelled ?? null,
  });
}

export { Channel };
