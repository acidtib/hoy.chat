// Typed wrappers around Tauri invoke(). Components call these, never invoke()
// directly. Command names and arg shapes mirror src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentEvent,
  ModelInfo,
  PiState,
  ProviderAuth,
  ProviderInfo,
  SessionStats,
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
export function createSession(cwd: string): Promise<string> {
  return invoke<string>("create_session", { cwd });
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

export { Channel };
