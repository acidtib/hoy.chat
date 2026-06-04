// Typed wrappers around Tauri invoke(). Components call these, never invoke()
// directly. Command names and arg shapes mirror src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ModelInfo, PiState, ProviderAuth, ProviderInfo } from "./types";

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
