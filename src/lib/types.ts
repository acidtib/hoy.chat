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
// mock-conversation shape; built live from streaming AgentEvents (lib/turns.ts).
export type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      reasoning?: { text: string; seconds: number };
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

// UI-only grouping. Not backed by Pi's RPC yet: a thread maps to a Pi session and
// a project to a working directory once persistence lands (next milestone). Kept
// here so the sidebar renders from typed state, not ad hoc shapes.
export interface Thread {
  id: string;
  title: string;
  // Epoch ms of last activity; drives the relative timestamp in the sidebar.
  updatedAt: number;
  // The real Pi session this thread drives, once one exists.
  sessionId?: string | null;
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
}

// Mirror of pi_config::ProviderAuth. Carries configured status only, never a key.
export interface ProviderAuth {
  provider: string;
  configured: boolean;
  kind?: "api_key" | "oauth" | "unknown" | null;
  source?: "authFile" | "environment" | null;
  removable: boolean;
}
