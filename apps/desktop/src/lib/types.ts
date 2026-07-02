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
  | ({ kind: "permissionRequest" } & PermissionRequest)
  // Fire-and-forget extension UI display methods (no response). Mirror of the
  // Notify/SetStatus/SetWidget/SetTitle/SetEditorText events in events.rs.
  | { kind: "notify"; message: string; notifyType?: NotifyType }
  | { kind: "setStatus"; statusKey: string; statusText?: string }
  | {
      kind: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: WidgetPlacement;
    }
  | { kind: "setTitle"; title: string }
  | { kind: "setEditorText"; text: string }
  // Pi's queue_update: the current steering/follow-up queues, driving the
  // composer's queued-message chips (HOY-218). Session-level, not a turn block.
  | { kind: "queueUpdate"; steering: string[]; followUp: string[] }
  | { kind: "reasoning"; delta?: string; phase: "start" | "delta" | "end" }
  | {
      kind: "compactionEnd";
      reason: string;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
    }
  | { kind: "error"; message: string }
  | { kind: "aborted" }
  | { kind: "done" };

export type NotifyType = "info" | "warning" | "error";
export type WidgetPlacement = "aboveEditor" | "belowEditor";

// An extension `notify` notice, surfaced transiently in the thread (HOY: ext UI).
export interface Notice {
  id: number;
  message: string;
  type: NotifyType;
}

// An extension `setWidget` panel, keyed by widgetKey, rendered around the composer.
export interface ExtWidget {
  lines: string[];
  placement: WidgetPlacement;
}

// An extension UI dialog awaiting an answer (HOY-186). The agent is blocked
// until respondPermission resolves it; rendered as an inline approval card.
export interface PermissionRequest {
  requestId: string;
  // "select" (options), "confirm" (yes/no message), "input" (text + placeholder),
  // "editor" (multiline + prefill).
  method: string;
  title: string;
  message?: string;
  options?: string[];
  // "input" hint and "editor" seed text (extension UI coverage).
  placeholder?: string;
  prefill?: string;
  // HOY-199: tool call metadata for rendering a pending tool block in the
  // conversation while the approval card waits for a decision.
  toolCallId?: string;
  toolName?: string;
  toolArgs?: unknown;
}

// The four thread permission modes (HOY-186). Wire values; the composer maps
// them to display labels.
export type PermissionMode = "default" | "acceptEdits" | "plan" | "autonomous";

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
// `pending` is true for blocks inserted before execution (from permissionRequest,
// HOY-199) while awaiting user approval.
export interface ToolUI {
  id: string;
  name: string;
  title: string;
  command?: string;
  diff?: string;
  output: string;
  isError?: boolean;
  running: boolean;
  pending?: boolean;
}

// An ordered block in an assistant turn, rendered top to bottom. Text blocks
// and tool blocks interleave naturally so each message's content stays in the
// order the model produced it.
export type AssistantBlock =
  | { kind: "text"; content: string }
  | { kind: "tool"; tool: ToolUI };

// The per-thread transcript model, keyed by threadId in the store. Replaces the
// built live from streaming AgentEvents and restored transcripts (lib/turns.ts).
// Wire shape Pi's prompt.images[] expects. `data` is raw base64, no data: URI
// prefix. Mirror of events.rs ImageContent.
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

// A composer-local image before send: carries a preview URL for the thumbnail
// and the encoded payload. Only `content` crosses the IPC boundary.
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  // Object URL for the <img> preview; revoked on remove and after send.
  previewUrl: string;
  content: ImageContent;
}

// How a mid-turn prompt is delivered while a turn already streams (HOY-218).
export type StreamingBehavior = "steer" | "followUp";

// One entry in the @ context picker's file list (HOY-220). Mirror of commands.rs
// PathEntry; `path` is relative to the project root.
export interface PathEntry {
  path: string;
  name: string;
  isDir: boolean;
}

// A piece of context attached to a message via the @ picker (HOY-220). Pi has no
// per-message context, so on submit each ref is inlined into the message text
// (file/dir content or a thread transcript). Rendered as a removable pill.
export type ContextRef =
  | { kind: "file"; path: string; name: string }
  | { kind: "directory"; path: string; name: string }
  | { kind: "thread"; threadId: string; title: string };

// Stable identity for dedup and removal: files/dirs by path, threads by id.
export function contextKey(ref: ContextRef): string {
  return ref.kind === "thread" ? `t:${ref.threadId}` : `${ref.kind[0]}:${ref.path}`;
}

export type Turn =
  | {
      role: "user";
      text: string;
      images?: ImageContent[];
      // @ context attached to this send (HOY-220), for display pills. Not
      // restored from disk (the content is inlined into the message text).
      contexts?: ContextRef[];
    }
  | {
      role: "assistant";
      reasoning?: { text: string; seconds?: number; active?: boolean };
      blocks: AssistantBlock[];
      streaming: boolean;
      // The user stopped this turn (HOY-197). Renders a subtle inline marker
      // after the turn's content instead of a thread-level error banner.
      aborted?: boolean;
      // The turn failed (a stream error or a failed prompt request). Renders
      // inline at the bottom of the turn, not as the top banner (HOY-214).
      error?: string;
    };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  // Pi's Model.input: ["text","image",...]. Gates the image attachment UI.
  input?: string[] | null;
}

// Whether a model accepts image input. Fail soft: only block attachments when we
// positively know `input` exists and lacks "image" (older payloads omit it).
export function modelSupportsImages(model?: ModelInfo | null): boolean {
  if (!model?.input) return true;
  return model.input.includes("image");
}

export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: ThinkingLevel[] =
  ["off", "minimal", "low", "medium", "high", "xhigh"];

// Pi's CompactionResult, returned by the compact command (HOY-229).
export interface CompactionResult {
  tokensBefore: number;
  estimatedTokensAfter?: number;
  summary?: string;
}

export interface PiState {
  model?: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionId: string;
  sessionName?: string | null;
  messageCount: number;
  pendingMessageCount: number;
  autoCompactionEnabled: boolean;
}

// Mirror of events.rs SlashCommand: a command for the composer "/" autocomplete
// (HOY-223). `name` has no leading slash; skills are "skill:<name>". "hoy" is a
// Hoy built-in (e.g. /compact) added client-side, not returned by get_commands.
export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "hoy";
}

// Session tree read surface (0.80.3, HOY-221). The Rust get_entries / get_tree
// commands pass Pi's response `data` through untyped (serde_json::Value), so these
// mirror Pi's SessionEntry / SessionTreeNode shapes on the TS side for a future
// /tree navigator. A "message" entry embeds Pi's AgentMessage, which Hoy treats
// opaquely everywhere else (getMessages returns unknown[]), so it stays `unknown`.
export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type SessionEntry =
  | (SessionEntryBase & { type: "message"; message: unknown })
  | (SessionEntryBase & { type: "thinking_level_change"; thinkingLevel: string })
  | (SessionEntryBase & {
      type: "model_change";
      provider: string;
      modelId: string;
    })
  | (SessionEntryBase & {
      type: "compaction";
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details?: unknown;
      fromHook?: boolean;
    })
  | (SessionEntryBase & {
      type: "branch_summary";
      fromId: string;
      summary: string;
      details?: unknown;
      fromHook?: boolean;
    })
  | (SessionEntryBase & { type: "custom"; customType: string; data?: unknown })
  | (SessionEntryBase & {
      type: "custom_message";
      customType: string;
      content: unknown;
      details?: unknown;
      display: boolean;
    })
  | (SessionEntryBase & {
      type: "label";
      targetId: string;
      label: string | undefined;
    })
  | (SessionEntryBase & { type: "session_info"; name?: string });

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  // Resolved label for this entry, if any.
  label?: string;
  labelTimestamp?: string;
}

// get_entries response `data`: the flat, id/parentId-linked entry list plus the
// current leaf.
export interface SessionEntries {
  entries: SessionEntry[];
  leafId: string | null;
}

// get_tree response `data`: the recursive node forest plus the current leaf.
export interface SessionTree {
  tree: SessionTreeNode[];
  leafId: string | null;
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
  // Unsent composer text, present only in the persisted workspace shape; the
  // live value lives in the store's drafts slice.
  draft?: string | null;
  // Selected model. Set on pick (deferred until a session exists), hydrated from
  // get_state after spawn. Ephemeral: the session JSONL owns it after the first
  // prompt, and persistProjects' allowlist never serializes it.
  model?: ModelRef | null;
  // Permission mode (HOY-186). Persisted with the thread; absent means default.
  // Applied to the live sidecar via /hoy_mode, re-applied after spawn/restore.
  permissionMode?: PermissionMode | null;
  // Thinking level (HOY-204). Session-local only, not persisted; workspace.rs
  // knows nothing of this field. Hydrated from get_state on session open.
  thinkingLevel?: ThinkingLevel | null;
}

// Mirror of workspace.rs Workspace: the persisted projects -> threads tree.
export interface Workspace {
  projects: Project[];
  // Last project worked in, restored across restarts (HOY-236).
  activeProjectId?: string | null;
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

// Mirror of events::OAuthSelectOption.
export interface OAuthSelectOption {
  id: string;
  label: string;
}

// Mirror of events::OAuthEvent. Streamed over a Channel during a subscription
// login (oauth_login_start). Keep in sync with src-tauri/src/events.rs.
export type OAuthEvent =
  | { kind: "authUrl"; url: string; instructions?: string }
  | {
      kind: "deviceCode";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { kind: "progress"; message: string }
  | {
      kind: "prompt";
      promptType: "text" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | { kind: "select"; message: string; options: OAuthSelectOption[] }
  | { kind: "done" }
  | { kind: "error"; message: string };
