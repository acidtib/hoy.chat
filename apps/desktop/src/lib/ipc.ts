// Typed wrappers around Tauri invoke(). Components call these, never invoke()
// directly. Command names and arg shapes mirror src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentEvent,
  CompactionResult,
  GoalAudit,
  GoalEvaluation,
  GoalVerifyResult,
  ImageContent,
  McpScope,
  McpServerList,
  ModelInfo,
  ModelRef,
  OAuthEvent,
  CloneResult,
  ForkMessages,
  ForkResult,
  PathEntry,
  PermissionMode,
  PiState,
  ProviderAuth,
  ProviderInfo,
  SessionEntries,
  SessionStats,
  SessionTree,
  SlashCommand,
  StreamingBehavior,
  SubagentDef,
  SubagentScope,
  ThinkingLevel,
  UsageReport,
  Workspace,
} from "./types";

// Native directory picker for adding a project. Returns the chosen absolute path,
// or null if the user cancels.
export async function pickDirectory(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    ...(defaultPath ? { defaultPath } : null),
  });
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

// The session's slash commands (extensions, prompt templates, skills) for the
// composer "/" autocomplete (HOY-223).
export function getCommands(sessionId: string): Promise<SlashCommand[]> {
  return invoke<SlashCommand[]>("get_commands", { sessionId });
}

export function setModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  return invoke<void>("set_model", { sessionId, provider, modelId });
}

export function setThinkingLevel(
  sessionId: string,
  level: ThinkingLevel,
): Promise<void> {
  return invoke<void>("set_thinking_level", { sessionId, level });
}

export function compact(
  sessionId: string,
  customInstructions?: string,
): Promise<CompactionResult> {
  return invoke<CompactionResult>("compact", {
    sessionId,
    customInstructions: customInstructions ?? null,
  });
}

export function setAutoCompaction(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("set_auto_compaction", { sessionId, enabled });
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

// MCP server config (HOY-232). `projectPath` is the active project's dir, needed
// for project-scope entries; omit for global-only. save/remove respawn idle
// sidecars in Rust so they reload the merged config, so callers should clear the
// per-session reconcile guards after (see the store actions).
export function listMcpServers(projectPath?: string | null): Promise<McpServerList> {
  return invoke<McpServerList>("list_mcp_servers", { projectPath: projectPath ?? null });
}

export function saveMcpServer(
  scope: McpScope,
  name: string,
  spec: Record<string, unknown>,
  projectPath?: string | null,
): Promise<void> {
  return invoke<void>("save_mcp_server", { scope, name, spec, projectPath: projectPath ?? null });
}

export function removeMcpServer(
  scope: McpScope,
  name: string,
  projectPath?: string | null,
): Promise<void> {
  return invoke<void>("remove_mcp_server", { scope, name, projectPath: projectPath ?? null });
}

// Subagent registry (HOY-234): builtin/global/project subagent types, merged
// with each scope's enabled/disabled overrides. `cwd` resolves the project
// scope; an empty cwd falls back to the backend's default dir like other
// per-project commands.
export function listSubagents(cwd: string): Promise<SubagentDef[]> {
  return invoke<SubagentDef[]>("list_subagents", { cwd });
}

export function setSubagentEnabled(
  scope: SubagentScope,
  name: string,
  enabled: boolean,
  projectPath?: string | null,
): Promise<void> {
  return invoke<void>("set_subagent_enabled", {
    scope,
    name,
    enabled,
    projectPath: projectPath ?? null,
  });
}

// Spawn a thread's own sidecar in its project dir, returning the sessionId the
// thread then drives. Empty cwd falls back to the backend's default dir.
// `sessionFile` reopens an existing transcript (M4 restore); omit for a new one.
// `subagentType`/`permissionMode` (HOY-231) brand and gate a spawned child
// thread's sidecar; omit for an ordinary user thread.
// `depth` (HOY-245) is the thread's position in the subagent tree (root = 0);
// the sidecar uses it to decide whether to grant the `agent` tool.
// `requireSubagentApproval` (HOY-248) relays the renderer pref of the same name
// to the sidecar as HOY_REQUIRE_SUBAGENT_APPROVAL; when false (default) the
// `agent` tool spawns without a consent prompt.
export function createSession(
  cwd: string,
  sessionFile: string | null | undefined,
  subagentType: string | null | undefined,
  permissionMode: string | null | undefined,
  depth: number,
  requireSubagentApproval: boolean,
  inheritFromSession: string | null | undefined,
): Promise<string> {
  return invoke<string>("create_session", {
    cwd,
    sessionFile: sessionFile ?? null,
    subagentType: subagentType ?? null,
    permissionMode: permissionMode ?? null,
    depth,
    requireSubagentApproval,
    inheritFromSession: inheritFromSession ?? null,
  });
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

// Sidecar-free transcript read (HOY-287): parse the thread's session JSONL off
// disk, returning the same raw Pi AgentMessage[] as getMessages. Lets a reopened
// thread render instantly before its sidecar is live; the caller reconciles with
// getMessages once the session is up. `sessionFile` is the thread's stored path.
export function readSessionTranscript(sessionFile: string): Promise<unknown[]> {
  return invoke<unknown[]>("read_session_transcript", { sessionFile });
}

// Read the session's tree entries (0.80.3, HOY-221): the flat SessionEntry list
// plus the current leafId. Read side of the fork/tree gap; backs a future /tree
// navigator. `since` returns only entries after that entry id (incremental read).
export function getEntries(
  sessionId: string,
  since?: string,
): Promise<SessionEntries> {
  return invoke<SessionEntries>("get_entries", {
    sessionId,
    since: since ?? null,
  });
}

// Read the session tree snapshot (0.80.3, HOY-221): the recursive node forest plus
// the current leafId. Pairs with getEntries for the future /tree navigator.
export function getTree(sessionId: string): Promise<SessionTree> {
  return invoke<SessionTree>("get_tree", { sessionId });
}

// Branch a new session from a user-message entry (HOY-281). Pi writes a new
// session file (original preserved, `parentSession` set) and rebinds THIS
// sidecar to the branch, so the session's file changes — read it back with
// getSessionStats afterwards. `text` is the forked user message (composer
// prefill); `cancelled` is true if the user aborted a confirm.
export function forkSession(
  sessionId: string,
  entryId: string,
): Promise<ForkResult> {
  return invoke<ForkResult>("fork_session", { sessionId, entryId });
}

// Duplicate the active branch into a new session file (HOY-281). Like fork at
// the current leaf. Rebinds this sidecar to the clone.
export function cloneSession(sessionId: string): Promise<CloneResult> {
  return invoke<CloneResult>("clone_session", { sessionId });
}

// List the session's forkable user messages (HOY-281), for a fork picker.
export function getForkMessages(sessionId: string): Promise<ForkMessages> {
  return invoke<ForkMessages>("get_fork_messages", { sessionId });
}

export function deleteSessionFile(sessionFile: string): Promise<void> {
  return invoke<void>("delete_session_file", { sessionFile });
}

// Toggle the OS keep-awake behavior (HOY-188). Synced from the
// keepAwakeWhileStreaming pref on boot and whenever it changes; the backend's
// owner thread only holds the wake lock while a turn streams AND this is on.
export function setKeepAwake(enabled: boolean): Promise<void> {
  return invoke<void>("set_keep_awake", { enabled });
}

export function loadWorkspace(): Promise<Workspace> {
  return invoke<Workspace>("load_workspace");
}

export function saveWorkspace(workspace: Workspace): Promise<void> {
  return invoke<void>("save_workspace", { workspace });
}

// Send a prompt and stream the turn. Resolves once Pi accepts the prompt; tokens,
// tool calls, and the terminal `done` arrive on `onEvent`, never via the return.
// `images` attaches vision content; `streamingBehavior` ("steer"|"followUp")
// queues the message when a turn is already streaming (HOY-205 / HOY-218).
export function sendPrompt(
  sessionId: string,
  message: string,
  onEvent: Channel<AgentEvent>,
  images?: ImageContent[],
  streamingBehavior?: StreamingBehavior,
): Promise<void> {
  return invoke<void>("send_prompt", {
    sessionId,
    message,
    images: images && images.length > 0 ? images : null,
    streamingBehavior: streamingBehavior ?? null,
    onEvent,
  });
}

// Queue a steer/follow-up into the turn already streaming (HOY-218). No Channel:
// events keep arriving on the turn's original channel. Reusing sendPrompt here
// (a second invoke with the same Channel) orphans delivery and freezes the turn.
export function enqueuePrompt(
  sessionId: string,
  message: string,
  images: ImageContent[] | undefined,
  streamingBehavior: StreamingBehavior,
): Promise<void> {
  return invoke<void>("enqueue_prompt", {
    sessionId,
    message,
    images: images && images.length > 0 ? images : null,
    streamingBehavior,
  });
}

// List project files/dirs for the @ context picker (HOY-220). `query` is a
// substring filter over the relative path; results are gitignore-aware and capped.
export function listProjectPaths(
  root: string,
  query: string,
  limit = 50,
): Promise<PathEntry[]> {
  return invoke<PathEntry[]>("list_project_paths", { root, query, limit });
}

// Read a project file's content to inline as @ context (HOY-220). Path-guarded to
// `root` and size-capped in Rust.
export function readContextFile(root: string, path: string): Promise<string> {
  return invoke<string>("read_context_file", { root, path });
}

export function getSessionStats(sessionId: string): Promise<SessionStats> {
  return invoke<SessionStats>("get_session_stats", { sessionId });
}

// HOY-262: aggregate local usage stats parsed from session transcripts.
export function getUsageStats(): Promise<UsageReport> {
  return invoke<UsageReport>("get_usage_stats");
}

// Goal Mode (HOY-263): judge the thread's transcript against `condition` via a
// one-shot evaluator sidecar. `evaluatorModel` pins the judge model; omit to let
// the sidecar pick a cheap available one. Always resolves to { met, reason }:
// the evaluator fails open to met:false on any error, so Task 5's loop keeps
// working on uncertainty rather than falsely stopping.
export function evaluateGoal(
  sessionId: string,
  condition: string,
  evaluatorModel?: ModelRef,
): Promise<GoalEvaluation> {
  return invoke<GoalEvaluation>("evaluate_goal", {
    sessionId,
    condition,
    evaluatorModel: evaluatorModel ?? null,
  });
}

// Goal Mode v2 (HOY-298): run a goal's deterministic verify command via a
// one-shot sidecar. `cwd` overrides where the command runs (a per-goal
// verifyCwd); omit to run in the session's own cwd. Always resolves to
// { code, stdout, stderr, killed }: the sidecar fails soft, emitting a non-zero
// `code` on any command failure or timeout, so Task B's gate treats a non-zero
// result as "not met, keep working".
export function verifyGoalCommand(
  sessionId: string,
  command: string,
  cwd?: string,
): Promise<GoalVerifyResult> {
  return invoke<GoalVerifyResult>("verify_goal_command", {
    sessionId,
    command,
    cwd: cwd ?? null,
  });
}

// Goal Mode v3 (HOY-299): run the independent read-only auditor via a one-shot
// sidecar. `cwd` overrides where the auditor reads (a per-goal cwd); omit to run
// in the session's own cwd. Always resolves to { met, reason }: the auditor fails
// open to met:false on any error or timeout, so Task B's loop keeps working on
// uncertainty rather than falsely stopping.
export function auditGoal(
  sessionId: string,
  condition: string,
  cwd?: string,
): Promise<GoalAudit> {
  return invoke<GoalAudit>("audit_goal", {
    sessionId,
    condition,
    cwd: cwd ?? null,
  });
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

// Start a subscription OAuth login. Resolves once the login child is spawned;
// the flow (auth URL, prompts, done/error) streams on `onEvent`. Only one login
// runs at a time. The renderer opens the auth URL and submits pasted codes via
// oauthLoginSubmit.
export function oauthLoginStart(
  provider: string,
  onEvent: Channel<OAuthEvent>,
): Promise<void> {
  return invoke<void>("oauth_login_start", { provider, onEvent });
}

// Feed back a line the login flow requested (pasted code / redirect URL, or a
// selected option id).
export function oauthLoginSubmit(text: string): Promise<void> {
  return invoke<void>("oauth_login_submit", { text });
}

export function oauthLoginCancel(): Promise<void> {
  return invoke<void>("oauth_login_cancel", {});
}

export { Channel };
