// Mirror of src-tauri/src/events.rs. Change both together.

export type ToolPhase = "start" | "update" | "end";

export type AgentEvent =
  | { kind: "text"; delta: string }
  | {
      kind: "tool";
      phase: ToolPhase;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      output?: string;
      isError?: boolean;
    }
  | { kind: "status"; label: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

// Mirror of events.rs SessionStats. Powers the bottom context bar. contextUsage
// (and its tokens/percent) is null/absent right after compaction until the next
// assistant response: render a dash, not zeroes.
export interface SessionStats {
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  // Durable path of the session's JSONL on disk (M4); persisted onto the thread
  // so it can be reopened after restart. Null for an in-memory session.
  sessionFile?: string | null;
}

// A single tool call rendered in a turn. Built from `tool` AgentEvents (start
// opens it, update/end fill output). `running` flips false on the end event.
export interface ToolUI {
  id: string;
  name: string;
  title: string;
  command?: string;
  diff?: string;
  output: string;
  isError?: boolean;
  running: boolean;
}

// The per-thread transcript model, keyed by threadId in the store. Replaces the
// built live from streaming AgentEvents and restored transcripts (lib/turns.ts).
export type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      reasoning?: { text: string; seconds?: number };
      tools: ToolUI[];
      text: string;
      streaming: boolean;
    };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
}

export interface PiState {
  model?: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionId: string;
  sessionName?: string | null;
  messageCount: number;
  pendingMessageCount: number;
  autoCompactionEnabled: boolean;
}

// A provider/model pair as Pi's set_model takes it. Lighter than ModelInfo for
// state that only needs identity, not capabilities.
export interface ModelRef {
  provider: string;
  id: string;
}

// UI-only grouping. Not backed by Pi's RPC yet: a thread maps to a Pi session and
// a project to a working directory once persistence lands (next milestone). Kept
// here so the sidebar renders from typed state, not ad hoc shapes.
export interface Thread {
  id: string;
  title: string;
  // Epoch ms of last activity; drives the relative timestamp in the sidebar.
  updatedAt: number;
  // The live sidecar process this thread drives right now (ephemeral; null when
  // no sidecar is running, e.g. after a panel close or a fresh app start).
  sessionId?: string | null;
  // The durable Pi session JSONL on disk (M4). This is the thread's stable
  // identity across restarts: reopening spawns a sidecar that opens this file.
  sessionFile?: string | null;
  // Archived threads leave the projects tree and live in the history view, where
  // they can be unarchived or permanently deleted.
  archived?: boolean;
  // Set once the user manually renames the thread. Recorded as a flag rather
  // than inferred from the title text, so renaming to the literal default still
  // counts. A renamed-but-never-prompted thread is user work and persists;
  // untouched threads never reach workspace.json.
  renamed?: boolean;
  // Selected model. Set on pick (deferred until a session exists), hydrated from
  // get_state after spawn. Ephemeral: the session JSONL owns it after the first
  // prompt, and persistProjects' allowlist never serializes it.
  model?: ModelRef | null;
}

// Mirror of workspace.rs Workspace: the persisted projects -> threads tree.
export interface Workspace {
  projects: Project[];
}

export interface Project {
  id: string;
  name: string;
  // Absolute path of the project's working directory, set when added via the
  // directory picker.
  path?: string | null;
  threads: Thread[];
}

// Mirror of pi_config::ProviderInfo. The provider picker list.
export interface ProviderInfo {
  id: string;
  label: string;
  // Env var Pi reads for this provider's key (e.g. google -> GEMINI_API_KEY).
  env: string;
}

// Mirror of pi_config::ProviderAuth. Carries configured status only, never a key.
export interface ProviderAuth {
  provider: string;
  configured: boolean;
  kind?: "api_key" | "oauth" | "unknown" | null;
  source?: "authFile" | "environment" | null;
  removable: boolean;
}
