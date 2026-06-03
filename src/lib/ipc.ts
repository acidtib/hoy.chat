// Typed wrappers around Tauri invoke(). Components call these, never invoke()
// directly. Command names and arg shapes mirror src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import type { PiState } from "./types";

export function activeSessionId(): Promise<string | null> {
  return invoke<string | null>("active_session_id");
}

export function getState(sessionId: string): Promise<PiState> {
  return invoke<PiState>("get_state", { sessionId });
}
