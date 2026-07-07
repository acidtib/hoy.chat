import { create } from "zustand";
import {
  abort,
  auditGoal,
  Channel,
  cloneSession,
  closeSession,
  compact as ipcCompact,
  setAutoCompaction as ipcSetAutoCompaction,
  createSession,
  deleteSessionFile,
  enqueuePrompt,
  evaluateGoal,
  forkSession,
  getCommands,
  getEntries,
  getForkMessages,
  getMessages,
  getSessionStats,
  getState,
  listSkills,
  getTree,
  getUsageStats,
  listProjectPaths,
  listSubagents,
  loadWorkspace,
  readContextFile,
  readSessionTranscript,
  removeMcpServer as ipcRemoveMcpServer,
  removeProviderKey as ipcRemoveProviderKey,
  respondPermission as ipcRespondPermission,
  saveMcpServer as ipcSaveMcpServer,
  saveProviderKey as ipcSaveProviderKey,
  saveWorkspace,
  sendPrompt,
  setModel,
  setPermissionMode as ipcSetPermissionMode,
  setSubagentEnabled as ipcSetSubagentEnabled,
  setThinkingLevel,
  verifyGoalCommand,
} from "@/lib/ipc";
import { applyEvent, markToolPending, messagesToTurns } from "@/lib/turns";
import { leafChainMessageIds } from "@/lib/treeNode";
import { fileToImageAttachment } from "@/lib/images";
import { draftContexts, draftToMessage } from "@/lib/mentions";
import { rewriteSkillCommand } from "@/lib/skill";
import {
  detectPlanIntent,
  extractProposedPlan,
  planKickoffPrompt,
  planSubagentKickoffPrompt,
  type PlanExecution,
} from "@/lib/plan";
import { formatElapsed, shortId } from "@/lib/utils";
import { usePrefsStore } from "@/state/prefs";
import {
  childThreadIdsOf,
  extractResultText,
  isSubagentThread,
  threadDepth,
  threadHasRunningSubagents,
} from "./delivery";
import { MAX_SUBAGENT_DEPTH, MAX_CONCURRENT_AGENTS } from "./limits";
import {
  frameSubagentResult,
  recordSubagentRequest,
  takeChildRequestsForParent,
  takeSubagentRequest,
} from "./subagent-requests";
import {
  applyEvaluation,
  GOAL_DEFAULT_CAP_TURNS,
  nextGoalAction,
  parseGoalCommand,
} from "./goal";
import type { EvaluationResult, ThreadGoal } from "./goal";
import type {
  AgentEvent,
  ContextRef,
  ExtWidget,
  GoalAudit,
  GoalVerifyResult,
  ImageAttachment,
  ImageContent,
  McpScope,
  ModelInfo,
  ModelRef,
  ForkMessage,
  Notice,
  NotifyType,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderAuth,
  ProviderInfo,
  RightDockView,
  SessionStats,
  SessionTree,
  SlashCommand,
  StreamingBehavior,
  SubagentDef,
  ThinkingLevel,
  Thread,
  Turn,
  UsageReport,
} from "@/lib/types";
import { isThinkingLevel } from "@/lib/types";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 256;

// Thread panels tile the main body left to right. A new panel fills the unused
// space (so the first one spans the whole body); once the body is full it
// borrows width from the others, never below this minimum.
export const PANEL_MIN_WIDTH = 460;

interface Panel {
  // Thread id the panel is showing. Panels are keyed by thread, so a thread is
  // open in at most one panel.
  id: string;
  width: number;
}

function initialBodyWidth(): number {
  if (typeof window !== "undefined") {
    return Math.max(PANEL_MIN_WIDTH, window.innerWidth - SIDEBAR_DEFAULT_WIDTH);
  }
  return 1200;
}

// Reduce the combined width of `panels` by `amount`, taking from each in
// proportion to its room above the minimum. Panels already at the minimum are
// left alone; if there isn't enough headroom the panels overflow and the body
// scrolls horizontally rather than crushing anything below the minimum.
function shrinkPanels(panels: Panel[], amount: number): Panel[] {
  const headroom = panels.map((p) => Math.max(0, p.width - PANEL_MIN_WIDTH));
  const total = headroom.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount <= 0) return panels;
  const take = Math.min(amount, total);
  return panels.map((p, i) => ({
    ...p,
    // Floor so rounding never sums above the body width (which would force a
    // spurious horizontal scroll); a sub-pixel remainder stays as empty space.
    width: Math.floor(p.width - (headroom[i] / total) * take),
  }));
}

// Distribute `amount` of extra width across `panels`, in proportion to their
// current width; the remainder goes to the last panel so the widths grow by
// exactly `amount`. The inverse of shrinkPanels.
function growPanels(panels: Panel[], amount: number): Panel[] {
  const total = panels.reduce((a, p) => a + p.width, 0);
  if (panels.length === 0 || amount <= 0 || total <= 0) return panels;
  let given = 0;
  return panels.map((p, i) => {
    const add =
      i === panels.length - 1
        ? amount - given
        : Math.floor((p.width / total) * amount);
    given += add;
    return { ...p, width: p.width + add };
  });
}

// Grow or shrink `panels` so they exactly fill `bodyWidth`. Shrinking respects
// the per-panel minimum (and may leave the strip overflowing); growing fills the
// reclaimed space so the panels never leave a gap beside them.
function fitPanels(panels: Panel[], bodyWidth: number): Panel[] {
  const used = panels.reduce((a, p) => a + p.width, 0);
  if (used > bodyWidth) return shrinkPanels(panels, used - bodyWidth);
  if (used < bodyWidth) return growPanels(panels, bodyWidth - used);
  return panels;
}

// Width for a panel added to `panels`, plus the (possibly shrunk) existing
// panels. Takes all the remaining space, or the minimum after shrinking the
// others when the body is already full.
function placeNewPanel(
  panels: Panel[],
  bodyWidth: number,
): { panels: Panel[]; width: number } {
  const used = panels.reduce((a, p) => a + p.width, 0);
  const available = bodyWidth - used;
  if (available >= PANEL_MIN_WIDTH) {
    return { panels, width: available };
  }
  return {
    panels: shrinkPanels(panels, PANEL_MIN_WIDTH - Math.max(0, available)),
    width: PANEL_MIN_WIDTH,
  };
}

// Items present in `prev` but no longer in `next` (multiset-aware). Used to detect
// which queued steer/follow-up messages Pi just delivered from a queueUpdate.
function removedItems(prev: string[], next: string[]): string[] {
  const remaining = [...next];
  const removed: string[] = [];
  for (const item of prev) {
    const i = remaining.indexOf(item);
    if (i >= 0) remaining.splice(i, 1);
    else removed.push(item);
  }
  return removed;
}

// Join a project root with a relative path for an ipc call (HOY-220). Paths are
// forward-slashed from list_project_paths; a trailing slash on root is tolerated.
function joinPath(root: string, rel: string): string {
  if (!root) return rel;
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

const MAX_THREAD_TRANSCRIPT_CHARS = 50000;

// Flatten a referenced thread's transcript to text for inlining as @ context
// (HOY-220). Built from the in-memory turns, so an unopened thread contributes
// nothing (its turns are not loaded); capped to bound token blowup.
function threadTranscript(threadId: string): string {
  const turns = useSessionStore.getState().turns[threadId] ?? [];
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      if (turn.text) lines.push(`user: ${turn.text}`);
    } else {
      const text = turn.blocks
        .filter((b) => b.kind === "text")
        .map((b) => (b.kind === "text" ? b.content : ""))
        .join("");
      if (text) lines.push(`assistant: ${text}`);
    }
  }
  const joined = lines.join("\n\n");
  return joined.length > MAX_THREAD_TRANSCRIPT_CHARS
    ? `${joined.slice(0, MAX_THREAD_TRANSCRIPT_CHARS)}\n... [truncated]`
    : joined;
}

// Build the delimited <context> block prepended to a message on submit (HOY-220).
// Files inline their (size-capped) content, directories a recursive path listing,
// threads their transcript. An unreadable ref is skipped rather than failing the
// send. Returns "" when nothing usable was gathered.
async function buildContextBlock(
  contexts: ContextRef[],
  root: string,
): Promise<string> {
  if (contexts.length === 0) return "";
  const parts: string[] = [];
  for (const ref of contexts) {
    if (ref.kind === "file") {
      if (!root) continue;
      try {
        const content = await readContextFile(root, ref.path);
        parts.push(`<file path="${attr(ref.path)}">\n${content}\n</file>`);
      } catch {
        // Skip an unreadable file; the rest of the send proceeds.
      }
    } else if (ref.kind === "directory") {
      if (!root) continue;
      try {
        const entries = await listProjectPaths(joinPath(root, ref.path), "", 500);
        const listing = entries
          .map((e) => `${e.path}${e.isDir ? "/" : ""}`)
          .join("\n");
        parts.push(
          `<directory path="${attr(ref.path)}">\n${listing}\n</directory>`,
        );
      } catch {
        // Skip an unreadable directory.
      }
    } else {
      const transcript = threadTranscript(ref.threadId);
      parts.push(`<thread title="${attr(ref.title)}">\n${transcript}\n</thread>`);
    }
  }
  if (parts.length === 0) return "";
  return `<context>\n${parts.join("\n")}\n</context>`;
}

// Sanitize a value for an XML-ish attribute in the context block; the model reads
// it as text, so a double quote just becomes a single quote.
function attr(value: string): string {
  return value.replace(/"/g, "'");
}

// The spawn notify payload for a subagent (HOY-231), carried through
// spawnChildThread and stashed in queuedPayloads while a child waits for a slot.
// `requestId` (HOY-300) is set for a synchronous spawn (subagentSpawnSync): the
// parent's agent tool is blocked on this request id and expects the child's
// result routed back to it on done.
type SpawnPayload = {
  agentId: string;
  subagentType: string;
  task: string;
  requestId: string;
};

// Session list is keyed by sessionId from the start so multi-session is a data
// change, not a redesign. Models, supported providers, and provider auth status
// are cached here so the top bar and settings page render from our state.
// Projects/threads drive the sidebar; `panels` is the set of threads open in the
// main body and `activeThreadId` is the focused one (null = home page).
interface SessionStore {
  projects: Project[];
  panels: Panel[];
  activeThreadId: string | null;
  // The last project the user worked in (opened/focused a thread, or added a
  // project). Survives closing all panels, so the home launcher can default a
  // new thread to it. Not persisted across restart; the recency fallback covers
  // a cold start.
  activeProjectId: string | null;
  bodyWidth: number;
  sidebarCollapsed: boolean;
  // Which view the sidebar shows: the projects -> threads tree, or the flat
  // time-bucketed history (toggled from the bottom-bar clock).
  sidebarView: "projects" | "history";
  // When history is opened scoped to one project (the sidebar's "N more" row,
  // HOY-257), this holds that project's id so ThreadHistory filters to it;
  // null = all threads. Cleared whenever the sidebar view is toggled directly.
  historyProjectId: string | null;
  sidebarWidth: number;
  bodyView: "panels" | "fleet" | "usage";
  // Global settings modal, openable from any entry point (home cog, thread menu).
  settingsOpen: boolean;
  activeSessionId: string | null;
  models: ModelInfo[];
  // Subagent type registry (HOY-234): builtin + global + project types merged
  // with their enabled/disabled overrides. Cached like models/providerAuth;
  // refreshSubagents repopulates it, spawnChildThread reads it to resolve a
  // child's model/thinking, the settings panel reads it to render the toggle.
  subagents: SubagentDef[];
  supportedProviders: ProviderInfo[];
  providerAuth: ProviderAuth[];
  // Pi's global defaultModel (boot-hydrated from the control session's state);
  // what a thread shows before it has its own pick.
  defaultModel: ModelRef | null;
  // Per-thread selector busy flag, keyed by threadId like the records below.
  modelSelecting: Record<string, boolean>;

  // Live streaming state, all keyed by threadId. `turns` is the transcript,
  // `streaming` gates each panel's composer, `stats` backs the context bar, and
  // `threadErrors` carries a per-thread failure banner.
  turns: Record<string, Turn[]>;
  streaming: Record<string, boolean>;
  stats: Record<string, SessionStats | null>;
  // HOY-262: aggregate local usage stats for the home dashboard. Loaded lazily
  // when the dashboard mounts; null until the first fetch resolves.
  usageReport: UsageReport | null;
  usageLoading: boolean;
  // Wall-clock of the last successful usage fetch, so refreshUsage can skip
  // re-walking the whole transcript tree on rapid home <-> panel navigation.
  usageFetchedAt: number | null;
  threadErrors: Record<string, string | null>;
  // Plan-mode handoff (HOY-213): a plan-mode turn that finished carrying a
  // proposed_plan block sets planReady[threadId] to the extracted plan text.
  // Drives the "Plan ready" card; transient (not persisted), cleared on
  // implement/dismiss and when the thread streams again.
  planReady: Record<string, string>;
  // Manual compaction in flight, keyed by threadId; gates the Compact affordance
  // and shows a compacting chip (HOY-229).
  compacting: Record<string, boolean>;
  // Approval cards awaiting an answer, keyed by threadId (HOY-186). Usually at
  // most one; pi preflights sibling tool calls sequentially, but a queue keeps
  // any overlap safe. Cleared on done and on panel close.
  pendingPermissions: Record<string, PermissionRequest[]>;
  // Extension UI display state, keyed by threadId (ext UI coverage). `notices`
  // are transient (notify); `statuses` are keyed footer chips (setStatus);
  // `widgets` are keyed panels around the composer (setWidget). statuses and
  // widgets persist across turns; all three are cleared on panel close.
  notices: Record<string, Notice[]>;
  statuses: Record<string, Record<string, string>>;
  widgets: Record<string, Record<string, ExtWidget>>;
  // Slash commands available to each thread's session (HOY-223), keyed by
  // threadId. Fetched once the session is acquired and cached; the composer "/"
  // autocomplete reads it. Empty until a session exists (degrades to built-ins).
  slashCommands: Record<string, SlashCommand[]>;
  // Skills for the active project context (HOY-323), as slash commands
  // (`skill:<name>`). Sourced from disk via list_skills, so they are available in
  // the composer "/" and "@skill:" pickers even before a session exists — unlike
  // slashCommands, which is session-gated. Refreshed when the active project
  // changes.
  skillCommands: SlashCommand[];
  // Session entry tree per thread (HOY-279), keyed by threadId, feeding the
  // `/tree` navigator. Absent until the navigator is opened for a thread; a
  // present entry means the tree is being observed, so refreshSessionTree keeps
  // only those fresh (turn done, fork). Session-scoped: dropped on panel close.
  sessionTree: Record<string, SessionTree | null>;
  // Which view the app's right-side dock shows (HOY-280), or null when closed.
  // A single global, app-level sidebar (Zed right-dock) mounted next to the whole
  // body, independent of any one thread panel: its content follows the active
  // thread. `/tree` is the first tenant; a git panel is a planned second.
  rightDock: RightDockView | null;
  // The /fork picker (HOY-284): the active thread's forkable user messages, or
  // null when closed. Picking one branches to a new thread via branchFromEntry.
  forkPicker: { threadId: string; messages: ForkMessage[] } | null;
  // Composer drafts keyed by threadId. Store-held so hidden panels and app
  // restarts keep unsent text; persisted via the workspace autosave as each
  // thread's draft field. Never cleared on panel close.
  drafts: Record<string, string>;
  // Pending image attachments for the composer, keyed by threadId (HOY-205).
  // In-memory only (base64 never touches disk); cleared on submit and on panel
  // close, revoking each preview object URL.
  composerAttachments: Record<string, ImageAttachment[]>;
  // Concurrency limiter for subagent spawns (HOY-245). All transient, never
  // persisted. `runningAgents` holds the child thread ids whose INITIAL run is
  // streaming (a slot each); `agentQueue` is the FIFO of child ids waiting for a
  // slot; `queuedPayloads` carries each queued child's spawn args so the pump
  // can replay them when a slot frees. Foreground and resume runs never touch
  // any of these.
  runningAgents: Set<string>;
  agentQueue: string[];
  queuedPayloads: Record<string, { payload: SpawnPayload; childDepth: number }>;
  // Pi's per-session steering/follow-up queues, keyed by threadId (HOY-218). Fed
  // by queueUpdate events (Pi sends full arrays, so we replace). Drives the
  // read-only queued-message chips. Cleared on panel close; abort leaves it
  // intact (Pi keeps the queue and delivers it on the next turn).
  queued: Record<string, { steering: string[]; followUp: string[] }>;
  // Full screen within the panel strip: the one panel rendered while set.
  // Widths in panels stay untouched so exiting restores the exact layout.
  // Not persisted.
  expandedThreadId: string | null;
  // One-shot composer focus request, set by openThread (a user asking to see
  // the thread) and consumed by ThreadView/Composer in an effect. The nonce
  // makes repeat clicks on the same thread re-fire. focusPanel (a pointer
  // landing inside a panel) never sets it, so in-panel clicks cannot yank
  // focus into the composer. Not persisted.
  focusRequest: { threadId: string; nonce: number } | null;
  // Teardown of a streaming thread asks first. requestTeardown gates the
  // three destructive actions in one place: idle threads tear down
  // immediately, streaming ones park here until the dialog confirms or
  // cancels. Not persisted.
  pendingTeardown: {
    action: "close" | "archive" | "delete";
    threadId: string;
  } | null;

  openThread: (id: string) => void;
  focusPanel: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  requestTeardown: (
    action: "close" | "archive" | "delete",
    threadId: string,
  ) => void;
  confirmTeardown: () => void;
  cancelTeardown: () => void;
  closePanel: (id: string) => void;
  // The panel header's close (X): a subagent panel is DISMISSED (removed from the
  // strip, sidecar keeps running, reopenable from Fleet), a root thread's
  // panel tears its sidecar down as before (HOY-301). Routes to dismissPanel or
  // requestTeardown accordingly.
  requestPanelClose: (threadId: string) => void;
  // Remove a panel from the strip WITHOUT tearing down its sidecar or dropping its
  // transcript: the thread keeps running and is reopenable with state intact.
  dismissPanel: (id: string) => void;
  dismissNotice: (threadId: string, id: number) => void;
  setDraft: (threadId: string, value: string) => void;
  // Image attachment management for the composer (HOY-205). addAttachments
  // encodes files to base64 in the renderer; removeAttachment/clearAttachments
  // revoke the preview object URLs they drop.
  addAttachments: (threadId: string, files: File[]) => Promise<void>;
  removeAttachment: (threadId: string, id: string) => void;
  clearAttachments: (threadId: string) => void;
  toggleFullScreen: (threadId: string) => void;
  setBodyWidth: (width: number) => void;
  resizePanelEdge: (index: number, deltaPx: number) => void;
  toggleSidebar: () => void;
  setSidebarView: (view: "projects" | "history") => void;
  // Open the history view scoped to a project (null = unscoped). HOY-257.
  openThreadHistory: (projectId: string | null) => void;
  setBodyView: (view: "panels" | "fleet" | "usage") => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  addProject: (path: string) => void;
  addThread: (projectId: string) => string;
  // Create a child thread for a spawned subagent (HOY-231) and drive it
  // through create_session + the shared streaming helper, same as a
  // user-submitted thread.
  spawnChildThread: (
    parentThreadId: string,
    payload: SpawnPayload,
  ) => Promise<void>;
  // Start as many queued subagent runs as free slots allow (HOY-245). Called
  // when a slot frees (an initial run's first done, or a teardown).
  pumpAgentQueue: () => void;
  removeProject: (projectId: string) => void;

  // Pull the subagent registry into the store (HOY-234). No-op cache miss on
  // failure (leaves the prior cache), mirroring refreshSlashCommands.
  refreshSubagents: (cwd: string) => Promise<void>;
  // Toggle a subagent type on/off in a scope. Writes through set_subagent_enabled
  // (Rust respawns idle sidecars to reload it), so the model/permission-mode
  // reconcile guards must clear like the other config-writing actions above.
  setSubagentEnabled: (
    scope: SubagentDef["scope"],
    name: string,
    enabled: boolean,
    projectPath?: string | null,
  ) => Promise<void>;

  // Credential changes go through the store (HOY-196): the backend respawns
  // idle sidecars under their existing sessionIds, so the per-session
  // reconcile guards must be cleared for the next prompt to re-apply each
  // thread's model pick and permission mode.
  saveProviderKey: (provider: string, key: string) => Promise<void>;
  removeProviderKey: (provider: string) => Promise<void>;
  // MCP config writes respawn idle sidecars too (they reload the merged config),
  // so the same reconcile guards must be cleared.
  saveMcpServer: (
    scope: McpScope,
    name: string,
    spec: Record<string, unknown>,
    projectPath?: string | null,
  ) => Promise<void>;
  removeMcpServer: (
    scope: McpScope,
    name: string,
    projectPath?: string | null,
  ) => Promise<void>;

  setActiveSessionId: (id: string | null) => void;
  setModels: (models: ModelInfo[]) => void;
  setSupportedProviders: (providers: ProviderInfo[]) => void;
  setProviderAuth: (providerAuth: ProviderAuth[]) => void;
  setDefaultModel: (model: ModelRef | null) => void;
  // Pick a model for one thread. Live session: set_model goes to that thread's
  // own sidecar. No session yet: the pick is recorded on the thread and applied
  // when its session spawns (defer, don't spawn).
  selectModel: (
    threadId: string,
    provider: string,
    modelId: string,
  ) => Promise<void>;
  // Pick a thinking level for one thread. Live session: set_thinking_level goes
  // to the sidecar. No session: the pick is deferred and reconciled against
  // get_state on spawn (applyThreadModel), like a deferred model pick.
  selectThinkingLevel: (threadId: string, level: ThinkingLevel) => Promise<void>;

  // Switch a thread's permission mode (HOY-186). Live session: applied via
  // /hoy_mode immediately (even mid-stream). No session yet: recorded on the
  // thread and applied when one spawns.
  setPermissionMode: (threadId: string, mode: PermissionMode) => Promise<void>;
  // Plan-mode handoff (HOY-213): approve the ready plan into execution by
  // switching the thread to `mode` and sending the kickoff prompt, or dismiss
  // the card (keep planning / discard) without executing. `execution` picks
  // inline execution (default) or task-by-task subagent orchestration (HOY-295).
  implementPlan: (
    threadId: string,
    mode: PermissionMode,
    execution?: PlanExecution,
  ) => Promise<void>;
  dismissPlanReady: (threadId: string) => void;
  // Answer the thread's oldest pending approval card.
  answerPermission: (
    threadId: string,
    requestId: string,
    answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => Promise<void>;

  // M4 persistence + lifecycle.
  initWorkspace: () => Promise<void>;
  hydrateThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => void;
  archiveThread: (threadId: string) => void;
  unarchiveThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;

  // Send a prompt. When a turn is already streaming, `behavior` queues the
  // message ("steer" delivers after the current tool calls, "followUp" after the
  // turn drains); it is ignored when idle (HOY-218).
  submitPrompt: (
    threadId: string,
    message: string,
    images?: ImageContent[],
    behavior?: StreamingBehavior,
    // HOY-291: opt out of auto-switching the thread into Plan Mode when the
    // message reads as a plan request. The plan-kickoff turn sets this so its
    // "implement this approved plan" instruction cannot bounce back into plan.
    opts?: { autoPlanMode?: boolean },
  ) => Promise<void>;
  // Create a thread from the home hero and send its first prompt in one step
  // (HOY-264). Records the chosen model/permission/thinking on the new
  // session-less thread, opens it (addThread), and submits; submitPrompt lazily
  // spawns the session and applies the deferred picks. The thread is only minted
  // here, on send, so opening home and leaving creates no empty thread.
  startThread: (
    projectId: string,
    message: string,
    opts: {
      model: ModelRef | null;
      permissionMode: PermissionMode;
      thinkingLevel: ThinkingLevel;
      images?: ImageContent[];
    },
  ) => void;
  // Abort the thread's streaming turn (HOY-195). The turn's terminal events
  // arrive over the channel as usual; no state is flipped here.
  stopStreaming: (threadId: string) => Promise<void>;
  refreshStats: (threadId: string) => Promise<void>;
  refreshUsage: () => Promise<void>;
  // Pull the session's slash commands into the store (HOY-223). No-op without a
  // live session; a failure degrades quietly to the built-ins.
  refreshSlashCommands: (threadId: string) => Promise<void>;
  // Pull the active project's skills into skillCommands from disk (HOY-323).
  // Session-independent (spawns a one-shot), so the composer shows skills before
  // any message is sent. A failure leaves the prior list.
  refreshSkills: (projectPath: string | null) => Promise<void>;
  // Pull the session's entry tree into the store for the `/tree` navigator
  // (HOY-279). No-op without a live session; a failure leaves the prior tree.
  refreshSessionTree: (threadId: string) => Promise<void>;
  // Global right-side dock host (HOY-280). toggleRightDock opens the view (and
  // primes the active thread's data — for "tree", a getTree read) or closes it
  // if already showing; closeRightDock just closes it.
  toggleRightDock: (view: RightDockView) => void;
  closeRightDock: () => void;
  // Branch a new thread from a session entry (HOY-283): opens a sidecar on the
  // source file, forks it to a new branch file (source untouched), and surfaces
  // the branch as a child thread seeded to that point.
  branchFromEntry: (threadId: string, entryId: string) => Promise<void>;
  // Duplicate the current thread's active branch into a new child thread via the
  // clone RPC (HOY-284): the source is untouched, no composer prefill.
  cloneThread: (threadId: string) => Promise<void>;
  // The /fork picker (HOY-284). openForkPicker fetches the thread's forkable user
  // messages and opens the palette; pickFork branches from the chosen entry;
  // closeForkPicker dismisses it.
  openForkPicker: (threadId: string) => Promise<void>;
  pickFork: (entryId: string) => void;
  closeForkPicker: () => void;
  // Trigger a manual compaction on the thread's session, optionally with custom
  // summarization instructions (HOY-229). Gated on an idle, live session.
  compact: (threadId: string, customInstructions?: string) => Promise<void>;
  // Fan a changed auto-compaction pref out to every currently-live session so a
  // mid-conversation toggle takes effect at once (HOY-275). The pref itself
  // (usePrefsStore.autoCompaction) is the source of truth, applied to each
  // session on spawn; this only reaches sessions that are already live.
  setAutoCompaction: (enabled: boolean) => Promise<void>;
  // Goal Mode (HOY-263): builtin /goal commands, intercepted in submitPrompt the
  // same way /compact is, so none of these ever round-trip through Pi.
  // Starts (or replaces) the thread's goal and kicks off the loop by sending
  // `condition` as a normal prompt (spawns the session, applies permission
  // mode/auto-compaction as usual).
  setGoal: (
    threadId: string,
    condition: string,
    // HOY-298/HOY-299: the parsed gates from the `/goal ... --verify "cmd" --audit`
    // command, threaded onto the new goal. Absent => v1 behavior (no command gate,
    // transcript evaluator).
    opts?: { verifyCommand?: string; evaluatorKind?: "transcript" | "auditor" },
  ) => Promise<void>;
  // Flips an active goal to paused. Does not abort an in-flight turn.
  pauseGoal: (threadId: string) => void;
  // Re-arms a paused/capped goal to active and sends a continuation prompt.
  resumeGoal: (threadId: string) => Promise<void>;
  // Marks the goal cleared and removes it from the thread. Does not abort an
  // in-flight turn.
  clearGoal: (threadId: string) => void;
  // Surfaces the goal's condition/status/turns/tokens/elapsed/lastReason as a
  // notice (the same transient notice mechanism /compact's result uses).
  showGoalStatus: (threadId: string) => void;
  setThreadSessionIdInternal: (threadId: string, sessionId: string) => void;
}

// How long a usage report stays fresh before refreshUsage re-walks disk.
const USAGE_TTL_MS = 30_000;

export const useSessionStore = create<SessionStore>((set, get) => ({
  // Empty until initWorkspace() loads the persisted tree from disk on boot.
  projects: [],
  panels: [],
  activeThreadId: null,
  activeProjectId: null,
  bodyWidth: initialBodyWidth(),
  sidebarCollapsed: usePrefsStore.getState().sidebarCollapsed,
  sidebarView: "projects",
  historyProjectId: null,
  settingsOpen: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  bodyView: "panels",
  activeSessionId: null,
  models: [],
  subagents: [],
  supportedProviders: [],
  providerAuth: [],
  defaultModel: null,
  modelSelecting: {},
  turns: {},
  streaming: {},
  stats: {},
  usageReport: null,
  usageLoading: false,
  usageFetchedAt: null,
  threadErrors: {},
  planReady: {},
  compacting: {},
  pendingPermissions: {},
  notices: {},
  statuses: {},
  widgets: {},
  slashCommands: {},
  skillCommands: [],
  sessionTree: {},
  rightDock: null,
  forkPicker: null,
  drafts: {},
  composerAttachments: {},
  runningAgents: new Set<string>(),
  agentQueue: [],
  queuedPayloads: {},
  queued: {},
  expandedThreadId: null,
  focusRequest: null,
  pendingTeardown: null,

  // Open the thread in a panel, or just focus it if it's already open. A
  // persisted thread (has a sessionFile, no live sidecar, nothing loaded) is
  // hydrated from disk in the background.
  openThread: (id) => {
    set((s) => {
      // Opening a different thread while full screen exits it: the user asked
      // to see something else.
      const expandedThreadId =
        s.expandedThreadId === id ? s.expandedThreadId : null;
      const focusRequest = {
        threadId: id,
        nonce: (s.focusRequest?.nonce ?? 0) + 1,
      };
      // Remember the project as the last worked in (drives the home launcher's
      // default target).
      const activeProjectId =
        findThread(s.projects, id)?.project.id ?? s.activeProjectId;
      if (s.panels.some((p) => p.id === id))
        return { activeThreadId: id, activeProjectId, expandedThreadId, focusRequest };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return {
        panels: [...panels, { id, width }],
        activeThreadId: id,
        activeProjectId,
        expandedThreadId,
        focusRequest,
      };
    });
    void get().hydrateThread(id);
  },

  // Pointer-down focus inside an open panel: active accent only, no composer
  // focus and no full screen change.
  focusPanel: (id) =>
    set((s) => ({
      activeThreadId: id,
      activeProjectId: findThread(s.projects, id)?.project.id ?? s.activeProjectId,
    })),

  setActiveProject: (id) => set({ activeProjectId: id }),

  requestTeardown: (action, threadId) => {
    // The confirm dialog only guards a live stream; when the user has turned that
    // guard off, or nothing is streaming, tear down immediately.
    const confirmStreaming = usePrefsStore.getState().confirmCloseStreaming;
    if (!get().streaming[threadId] || !confirmStreaming) {
      runTeardown(get(), action, threadId);
      return;
    }
    set({ pendingTeardown: { action, threadId } });
  },

  confirmTeardown: () => {
    const pending = get().pendingTeardown;
    if (!pending) return;
    set({ pendingTeardown: null });
    runTeardown(get(), pending.action, pending.threadId);
  },

  cancelTeardown: () => set({ pendingTeardown: null }),

  closePanel: (id) => {
    // Kill-on-close: tear down the live sidecar and drop the cached transcript so
    // reopening re-spawns and reloads from disk. The durable sessionFile stays on
    // the thread, so the conversation is not lost.
    const live = findThread(get().projects, id)?.thread.sessionId;
    if (live) releaseSession(live);
    // Abandon the streaming channel so the killed sidecar's trailing error/done
    // events are ignored rather than re-populating this thread's state.
    activeChannels.delete(id);
    // Drop any buffered (not-yet-flushed) streaming deltas for this thread so a
    // pending rAF flush can't re-populate the transcript we just dropped (HOY-292).
    streamDeltaBuffers.delete(id);
    // Manually closing a RUNNING subagent kills its sidecar above, so its
    // trailing done is dropped by the activeChannels guard and the done-path
    // slot release never fires. Purge it from the limiter and pump so the slot
    // frees (HOY-245). Idempotent for HOY-240 auto-close of a delivered child:
    // its initial done already released the slot, so purge is a no-op and the
    // pump harmlessly fills any free slot.
    purgeFromLimiter(id);
    get().pumpAgentQueue();
    set((s) => {
      const index = s.panels.findIndex((p) => p.id === id);
      if (index < 0) return s;
      // An untouched thread is discarded with its panel: the sidebar row goes
      // too, instead of an empty "New thread" lingering. Decided before the
      // turns record is dropped below.
      const found = findThread(s.projects, id);
      const discard = found
        ? isUntouched(found.thread, s.turns, s.drafts)
        : false;
      // Re-fit the survivors to the body, so closing re-flows the strip
      // instead of leaving a gap. Fit, not grow: when the strip was
      // overflowing, handing the closed panel's width to the survivors would
      // stack it (close all but one and that panel keeps the combined width).
      const panels = fitPanels(
        s.panels.filter((p) => p.id !== id),
        s.bodyWidth,
      );

      let activeThreadId = s.activeThreadId;
      if (activeThreadId === id) {
        const neighbor = panels[index] ?? panels[index - 1] ?? null;
        activeThreadId = neighbor?.id ?? null;
      }
      // Reset all per-thread live state so a reopen starts clean: a turn killed
      // mid-stream must not leave streaming/error flags stuck on the thread.
      const { [id]: _t, ...turns } = s.turns;
      const { [id]: _st, ...stats } = s.stats;
      const { [id]: _sg, ...streaming } = s.streaming;
      const { [id]: _er, ...threadErrors } = s.threadErrors;
      const { [id]: _ms, ...modelSelecting } = s.modelSelecting;
      // Pending approval cards die with the sidecar; the killed process needs
      // no answers.
      const { [id]: _pp, ...pendingPermissions } = s.pendingPermissions;
      // Extension UI display state is tied to the live sidecar; drop it too.
      const { [id]: _nt, ...notices } = s.notices;
      const { [id]: _ss, ...statuses } = s.statuses;
      const { [id]: _wg, ...widgets } = s.widgets;
      // The draft survives the close (it is user work, like thread.model);
      // only a discarded thread takes its (whitespace-only) entry with it.
      const { [id]: _dr, ...remainingDrafts } = s.drafts;
      // Attachments are tied to the live composer session; drop them and revoke
      // their preview URLs (HOY-205).
      const { [id]: closedAttachments, ...composerAttachments } =
        s.composerAttachments;
      for (const a of closedAttachments ?? []) URL.revokeObjectURL(a.previewUrl);
      // Queued messages die with the sidecar (HOY-218).
      const { [id]: _q, ...queued } = s.queued;
      // Slash commands are session-scoped; drop them so a reopen re-fetches.
      const { [id]: _slc, ...slashCommands } = s.slashCommands;
      // The session tree is session-scoped too; drop it so a reopen re-fetches
      // and a closed thread stops being refreshed on done (HOY-279).
      const { [id]: _tree, ...sessionTree } = s.sessionTree;
      return {
        panels,
        activeThreadId,
        turns,
        stats,
        streaming,
        threadErrors,
        modelSelecting,
        pendingPermissions,
        notices,
        statuses,
        widgets,
        composerAttachments,
        queued,
        slashCommands,
        sessionTree,
        drafts: discard ? remainingDrafts : s.drafts,
        expandedThreadId: s.expandedThreadId === id ? null : s.expandedThreadId,
        focusRequest: s.focusRequest?.threadId === id ? null : s.focusRequest,
        projects: discard
          ? s.projects.map((p) => ({
              ...p,
              threads: p.threads.filter((t) => t.id !== id),
            }))
          : patchThread(s.projects, id, (th) => ({ ...th, sessionId: null })),
      };
    });
  },

  requestPanelClose: (threadId) => {
    // Closing a subagent's panel should never stop its work: dismiss the view and
    // leave the sidecar running (reopenable from Fleet). Only a root thread's
    // panel is torn down on close, keeping the existing kill-on-close + streaming
    // confirm (HOY-301).
    const thread = findThread(get().projects, threadId)?.thread;
    if (thread && isSubagentThread(thread)) {
      get().dismissPanel(threadId);
      return;
    }
    get().requestTeardown("close", threadId);
  },

  dismissPanel: (id) =>
    set((s) => {
      const index = s.panels.findIndex((p) => p.id === id);
      if (index < 0) return s;
      // Remove from the strip and re-fit survivors, exactly like closePanel -- but
      // keep the sidecar, the channel, and every per-thread slice (turns, streaming,
      // sessionId, ...) so the thread keeps running and reopens with state intact.
      const panels = fitPanels(
        s.panels.filter((p) => p.id !== id),
        s.bodyWidth,
      );
      let activeThreadId = s.activeThreadId;
      if (activeThreadId === id) {
        const neighbor = panels[index] ?? panels[index - 1] ?? null;
        activeThreadId = neighbor?.id ?? null;
      }
      return {
        panels,
        activeThreadId,
        expandedThreadId: s.expandedThreadId === id ? null : s.expandedThreadId,
        focusRequest: s.focusRequest?.threadId === id ? null : s.focusRequest,
      };
    }),

  dismissNotice: (threadId, id) =>
    set((s) => ({
      notices: {
        ...s.notices,
        [threadId]: (s.notices[threadId] ?? []).filter((n) => n.id !== id),
      },
    })),

  setDraft: (threadId, value) =>
    set((s) => ({ drafts: { ...s.drafts, [threadId]: value } })),

  addAttachments: async (threadId, files) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const encoded = await Promise.all(images.map(fileToImageAttachment));
    set((s) => ({
      composerAttachments: {
        ...s.composerAttachments,
        [threadId]: [...(s.composerAttachments[threadId] ?? []), ...encoded],
      },
    }));
  },

  removeAttachment: (threadId, id) =>
    set((s) => {
      const list = s.composerAttachments[threadId] ?? [];
      const removed = list.find((a) => a.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return {
        composerAttachments: {
          ...s.composerAttachments,
          [threadId]: list.filter((a) => a.id !== id),
        },
      };
    }),

  clearAttachments: (threadId) =>
    set((s) => {
      for (const a of s.composerAttachments[threadId] ?? [])
        URL.revokeObjectURL(a.previewUrl);
      const { [threadId]: _drop, ...rest } = s.composerAttachments;
      return { composerAttachments: rest };
    }),

  toggleFullScreen: (threadId) =>
    set((s) => ({
      expandedThreadId: s.expandedThreadId === threadId ? null : threadId,
      // Entering or exiting full screen remounts panels; drop any pending
      // request so the remount cannot replay it.
      focusRequest: null,
    })),

  setBodyWidth: (width) =>
    set((s) => {
      if (width === s.bodyWidth) return s;
      if (s.panels.length === 0) return { bodyWidth: width };
      // Keep the panels filling the body: shrink them when it narrows, grow them
      // back into the reclaimed space when it widens.
      return { bodyWidth: width, panels: fitPanels(s.panels, width) };
    }),

  // Drag the divider on panel `index`'s right edge. Growing borrows from the
  // neighbor down to its minimum; once the neighbor is already at the minimum
  // (the panels overflow), the panel keeps growing and the strip scrolls instead
  // of the drag getting stuck. Shrinking hands the freed width to the neighbor.
  resizePanelEdge: (index, deltaPx) =>
    set((s) => {
      const panels = s.panels.map((p) => ({ ...p }));
      const cur = panels[index];
      const next = panels[index + 1];
      if (!cur || !next) return s;
      const d = Math.max(deltaPx, PANEL_MIN_WIDTH - cur.width);
      cur.width += d;
      if (d < 0) {
        next.width -= d;
      } else {
        next.width -= Math.min(d, next.width - PANEL_MIN_WIDTH);
      }
      return { panels };
    }),

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    usePrefsStore.getState().setPref("sidebarCollapsed", next);
  },
  setSidebarView: (view) => set({ sidebarView: view, historyProjectId: null }),
  openThreadHistory: (projectId) =>
    set({ sidebarView: "history", historyProjectId: projectId }),
  setBodyView: (view) => set({ bodyView: view }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSidebarWidth: (width) =>
    set({
      sidebarWidth: Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
      ),
    }),
  addProject: (path) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    // Seed a new project with one starter thread so it opens ready to use
    // (HOY-226). On the dedup path (path already open) add nothing; just surface
    // the existing project's most recent thread. openThread runs after set,
    // mirroring addThread.
    let openId: string | null = null;
    set((s) => {
      const existing = s.projects.find((p) => p.path === path);
      if (existing) {
        openId = existing.threads[0]?.id ?? null;
        return s;
      }
      const thread: Thread = {
        id: shortId("t"),
        title: "New thread",
        updatedAt: Date.now(),
        sessionId: null,
      };
      openId = thread.id;
      return {
        projects: [...s.projects, { id: shortId("p"), name, path, threads: [thread] }],
      };
    });
    if (openId) get().openThread(openId);
  },
  addThread: (projectId) => {
    const thread: Thread = {
      id: shortId("t"),
      title: "New thread",
      updatedAt: Date.now(),
      sessionId: null,
    };
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, threads: [thread, ...p.threads] } : p,
      ),
    }));
    get().openThread(thread.id);
    return thread.id;
  },
  spawnChildThread: async (parentThreadId, payload) => {
    const found = findThread(get().projects, parentThreadId);
    if (!found) return;
    const { project, thread: parent } = found;
    const childDepth = threadDepth(get().projects, parentThreadId) + 1;
    if (childDepth > MAX_SUBAGENT_DEPTH) {
      // Belt-and-suspenders: a parent at max depth should not have had the agent
      // tool at all (the sidecar withholds it), so this should be unreachable.
      // Guard against a stale sidecar rather than spawning past the cap.
      console.warn(`HOY-245: refusing spawn at depth ${childDepth} > ${MAX_SUBAGENT_DEPTH}`);
      return;
    }
    const childId = shortId("t");
    // HOY-300: remember which blocked parent request this child answers. A
    // synchronous spawn (subagentSpawnSync) carries the parent's requestId so the
    // child can respond in-band once its run is done.
    if (payload.requestId) {
      recordSubagentRequest(childId, {
        parentThreadId,
        parentSessionId: parent.sessionId!,
        requestId: payload.requestId,
      });
    }
    const def = get().subagents.find((d) => d.name === payload.subagentType);
    // A type with no model inherits the parent's (closes HOY-237); thinking
    // likewise. A type with a model that fails to resolve also falls back to
    // the parent's rather than spawning on an arbitrary default.
    const childModel = def?.model
      ? (resolveModelRef(get(), def.model) ?? parent.model ?? null)
      : (parent.model ?? null);
    // Validate the registry-supplied thinking string rather than casting it
    // blind (HOY-243); a malformed value falls back to the parent's level.
    const childThinking =
      (isThinkingLevel(def?.thinking) ? def.thinking : undefined) ??
      parent.thinkingLevel ??
      null;
    const shortTask =
      payload.task.length > 40 ? `${payload.task.slice(0, 40)}...` : payload.task;
    const child: Thread = {
      id: childId,
      title: `${payload.subagentType}: ${shortTask}`,
      updatedAt: Date.now(),
      sessionId: null,
      parentThreadId,
      spawnedBy: { type: payload.subagentType, agentId: payload.agentId },
      ...(childModel ? { model: childModel } : {}),
      ...(childThinking ? { thinkingLevel: childThinking } : {}),
    };
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, threads: [...p.threads, child] } : p,
      ),
      // Seed the user turn so the child is visible in the transcript even while
      // queued. The in-flight assistant turn + streaming[childId] are seeded by
      // startChildRun once a slot is taken, so a queued child shows the task but
      // does not stream (HOY-245).
      turns: {
        ...s.turns,
        [childId]: [{ role: "user", text: payload.task }],
      },
    }));
    // Auto-open the child so the user follows the run live instead of finding
    // it after the fact (HOY-236). The child is already in projects above, so
    // openThread's findThread resolves. Fleet (HOY-235) is the alternative
    // watch surface, so this is gated behind the autoOpenSpawnedThreads pref
    // (HOY-246), off by default to avoid a panel-per-subagent storm at scale.
    if (usePrefsStore.getState().autoOpenSpawnedThreads) get().openThread(childId);
    // Concurrency gate (HOY-245): an initial run takes a slot only if one is
    // free; otherwise the child waits FIFO. A slot releases on the run's first
    // done. Foreground and resume runs bypass this entirely (they never reach
    // here), which is what keeps deep trees deadlock-free under a small cap.
    if (get().runningAgents.size < concurrencyCap()) {
      set((s) => ({ runningAgents: new Set(s.runningAgents).add(childId) }));
      await startChildRun(childId, payload, childDepth);
    } else {
      set((s) => ({
        agentQueue: [...s.agentQueue, childId],
        queuedPayloads: {
          ...s.queuedPayloads,
          [childId]: { payload, childDepth },
        },
      }));
    }
  },
  pumpAgentQueue: () => {
    const s = get();
    if (!s.agentQueue.length || s.runningAgents.size >= concurrencyCap()) {
      return;
    }
    const [next, ...rest] = s.agentQueue;
    const entry = s.queuedPayloads[next];
    const { [next]: _dropped, ...restPayloads } = s.queuedPayloads;
    // A child torn down while queued (teardown purges its payload) or otherwise
    // gone: drop it and keep pumping so a live one behind it can start.
    if (!entry || !findThread(s.projects, next)) {
      set({ agentQueue: rest, queuedPayloads: restPayloads });
      get().pumpAgentQueue();
      return;
    }
    set({
      agentQueue: rest,
      runningAgents: new Set(s.runningAgents).add(next),
      queuedPayloads: restPayloads,
    });
    void startChildRun(next, entry.payload, entry.childDepth);
    // Fill any further free slots (cap may allow more than one).
    get().pumpAgentQueue();
  },
  removeProject: (projectId) => {
    // Tear down any live sidecars the project's threads are running.
    const removed = get().projects.find((p) => p.id === projectId);
    for (const t of removed?.threads ?? []) {
      if (t.sessionId) releaseSession(t.sessionId);
    }
    set((s) => {
      const ids = new Set(removed?.threads.map((t) => t.id) ?? []);
      // Re-fit the survivors to the body, like closePanel.
      const panels = fitPanels(
        s.panels.filter((p) => !ids.has(p.id)),
        s.bodyWidth,
      );
      let activeThreadId = s.activeThreadId;
      if (activeThreadId && ids.has(activeThreadId)) {
        activeThreadId = panels.at(-1)?.id ?? null;
      }
      return {
        projects: s.projects.filter((p) => p.id !== projectId),
        panels,
        activeThreadId,
        activeProjectId:
          s.activeProjectId === projectId ? null : s.activeProjectId,
      };
    });
  },

  saveProviderKey: async (provider, key) => {
    await ipcSaveProviderKey(provider, key);
    modelApplied.clear();
    permissionModeApplied.clear();
  },

  removeProviderKey: async (provider) => {
    await ipcRemoveProviderKey(provider);
    modelApplied.clear();
    permissionModeApplied.clear();
  },

  saveMcpServer: async (scope, name, spec, projectPath) => {
    await ipcSaveMcpServer(scope, name, spec, projectPath ?? null);
    modelApplied.clear();
    permissionModeApplied.clear();
  },

  removeMcpServer: async (scope, name, projectPath) => {
    await ipcRemoveMcpServer(scope, name, projectPath ?? null);
    modelApplied.clear();
    permissionModeApplied.clear();
  },

  refreshSubagents: async (cwd) => {
    try {
      set({ subagents: await listSubagents(cwd) });
    } catch {
      // Leave the prior cache; a stale registry beats an empty one.
    }
  },
  setSubagentEnabled: async (scope, name, enabled, projectPath) => {
    await ipcSetSubagentEnabled(scope, name, enabled, projectPath ?? null);
    modelApplied.clear();
    permissionModeApplied.clear();
  },

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setModels: (models) => set({ models }),
  setSupportedProviders: (supportedProviders) => set({ supportedProviders }),
  setProviderAuth: (providerAuth) => set({ providerAuth }),
  setDefaultModel: (defaultModel) => set({ defaultModel }),

  selectModel: async (threadId, provider, modelId) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread) return;
    const pick: ModelRef = { provider, id: modelId };
    set((s) => ({
      modelSelecting: { ...s.modelSelecting, [threadId]: true },
      threadErrors: { ...s.threadErrors, [threadId]: null },
    }));
    try {
      // Live session: apply to the sidecar first so a rejection leaves model
      // state untouched. No session: defer, don't spawn; the pick is applied
      // by the session-spawn path. defaultModel mirrors Pi, which persists the
      // pick globally on set_model but knows nothing of a deferred pick.
      if (thread.sessionId) await setModel(thread.sessionId, provider, modelId);
      set((s) => ({
        ...(thread.sessionId ? { defaultModel: pick } : null),
        projects: patchThread(s.projects, threadId, (th) => ({
          ...th,
          model: pick,
        })),
      }));
    } catch (e) {
      set((s) => ({
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    } finally {
      set((s) => ({
        modelSelecting: { ...s.modelSelecting, [threadId]: false },
      }));
    }
  },

  selectThinkingLevel: async (threadId, level) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread) return;
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        thinkingLevel: level,
      })),
      threadErrors: { ...s.threadErrors, [threadId]: null },
    }));
    if (!thread.sessionId) return;
    try {
      await setThinkingLevel(thread.sessionId, level);
      // Pi may clamp the level internally; sync the effective value back.
      const synced = await getState(thread.sessionId).catch(() => null);
      if (synced?.thinkingLevel) {
        set((s) => ({
          projects: patchThread(s.projects, threadId, (th) => ({
            ...th,
            thinkingLevel: synced.thinkingLevel,
          })),
        }));
      }
    } catch (e) {
      const piState = await getState(thread.sessionId).catch(() => null);
      set((s) => ({
        projects: patchThread(s.projects, threadId, (th) => ({
          ...th,
          thinkingLevel: piState?.thinkingLevel ?? "high",
        })),
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
  },

  setPermissionMode: async (threadId, mode) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread) return;
    const previous = thread.permissionMode ?? "default";
    if (previous === mode) return;
    // Optimistic: the selector reflects the pick immediately; a live-session
    // failure reverts it. No session: the pick is applied on spawn.
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        permissionMode: mode,
      })),
    }));
    if (!thread.sessionId) return;
    try {
      await ipcSetPermissionMode(thread.sessionId, mode);
      permissionModeApplied.add(thread.sessionId);
    } catch (e) {
      set((s) => ({
        projects: patchThread(s.projects, threadId, (th) => ({
          ...th,
          permissionMode: previous,
        })),
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
  },

  dismissPlanReady: (threadId) => {
    set((s) => {
      if (!(threadId in s.planReady)) return {};
      const planReady = { ...s.planReady };
      delete planReady[threadId];
      return { planReady };
    });
  },

  implementPlan: async (threadId, mode, execution = "inline") => {
    const plan = get().planReady[threadId];
    // Clear the card first so a double click cannot fire two kickoffs.
    get().dismissPlanReady(threadId);
    // Switch out of plan mode so the kickoff turn has full tool access (and, for
    // subagent execution, so the agent tool is advertised to the parent), then
    // send the plan as the opening instruction of the execution turn.
    await get().setPermissionMode(threadId, mode);
    // HOY-295: inline execution implements in this thread; subagent execution
    // orchestrates the plan one step per dispatched subagent.
    const kickoff =
      execution === "subagent"
        ? planSubagentKickoffPrompt(plan)
        : planKickoffPrompt(plan);
    // autoPlanMode: false — the kickoff instruction says "implement this approved
    // plan", which must not bounce the freshly-restored mode back into plan.
    await get().submitPrompt(threadId, kickoff, undefined, undefined, {
      autoPlanMode: false,
    });
  },

  answerPermission: async (threadId, requestId, answer) => {
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    // Remove the card first so a double click cannot answer twice; the backend
    // treats an unknown request id as a no-op write.
    set((s) => ({
      pendingPermissions: {
        ...s.pendingPermissions,
        [threadId]: (s.pendingPermissions[threadId] ?? []).filter(
          (r) => r.requestId !== requestId,
        ),
      },
    }));
    try {
      await ipcRespondPermission(sessionId, requestId, answer);
    } catch (e) {
      set((s) => ({
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
  },

  // Send a prompt from a thread panel and stream the response into its turns.
  // Lazily spawns the thread's own sidecar (session per thread) in the project's
  // cwd on first send, then drives one Channel per turn.
  submitPrompt: async (threadId, message, images, behavior, opts) => {
    const found = findThread(get().projects, threadId);
    if (!found) return;
    const { thread, project } = found;
    // A new user turn supersedes any pending plan-ready card (HOY-213).
    get().dismissPlanReady(threadId);

    // The message is the composer draft with @ mentions encoded inline (HOY-220).
    // `text` is the human-readable message (markers -> labels); `contexts` are the
    // referenced files/threads, inlined as a <context> block prepended to the text
    // Pi receives. The draft is cleared by the composer (setDraft "") on submit.
    const contexts = draftContexts(message);
    const text = draftToMessage(message).trim();

    // Hoy built-in /compact (HOY-223): intercept before the prompt path so it
    // never reaches Pi and never appends turns. Trailing text becomes the custom
    // summarization instructions; "/compact" alone compacts with the default.
    // Every other "/" message is a Pi command and flows through unchanged.
    const compactMatch = /^\/compact(?:\s+([\s\S]+))?$/.exec(text);
    if (compactMatch) {
      void get().compact(threadId, compactMatch[1]?.trim() || undefined);
      return;
    }

    // Hoy built-in /goal (HOY-263): same shape as /compact above -- intercept
    // before the prompt path so "/goal ...", "/goal pause", etc. never reach Pi
    // and never append turns of their own. parseGoalCommand is the single
    // source of truth for what counts as a /goal subcommand; a non-goal "/"
    // message (including "/goalish" typos) falls through unchanged.
    const goalCommand = parseGoalCommand(text);
    if (goalCommand) {
      switch (goalCommand.kind) {
        case "set":
          await get().setGoal(threadId, goalCommand.condition, {
            verifyCommand: goalCommand.verifyCommand,
            evaluatorKind: goalCommand.evaluatorKind,
          });
          break;
        case "pause":
          get().pauseGoal(threadId);
          break;
        case "resume":
          await get().resumeGoal(threadId);
          break;
        case "clear":
          get().clearGoal(threadId);
          break;
        case "status":
          get().showGoalStatus(threadId);
          break;
      }
      return;
    }

    // Hoy built-in /tree (HOY-280): toggle the session-tree navigator dock.
    // Intercepted before the prompt path so it never reaches Pi. Bare "/tree"
    // only; "/treeish" and "/tree foo" fall through unchanged.
    if (/^\/tree$/.test(text)) {
      get().toggleRightDock("tree");
      return;
    }

    // Hoy built-in /fork and /clone (HOY-284): branch commands intercepted before
    // the prompt path so they never reach Pi. Bare "/clone" duplicates the active
    // branch into a new thread; bare "/fork" opens the forkable-message picker.
    // "/forkish" and any trailing args fall through to Pi unchanged.
    if (/^\/clone$/.test(text)) {
      void get().cloneThread(threadId);
      return;
    }
    if (/^\/fork$/.test(text)) {
      void get().openForkPicker(threadId);
      return;
    }

    const hasImages = !!images && images.length > 0;
    if (!text && !hasImages && contexts.length === 0) return;

    // The composer's attachments are consumed by this send; clear them (and
    // revoke their previews) so they cannot be sent twice (HOY-205).
    get().clearAttachments(threadId);
    const contextBlock = await buildContextBlock(contexts, project.path ?? "");
    // Skill commands (HOY-323): the composer inserts a skill by its bare name
    // (/demo-review) like Claude Code, but Pi only expands the /skill:<name>
    // form. Rewrite the leading command for the message Pi receives; the visible
    // user turn keeps the bare text the user typed.
    const promptText = rewriteSkillCommand(text, [
      ...(get().slashCommands[threadId] ?? []),
      ...get().skillCommands,
    ]);
    const outbound = contextBlock ? `${contextBlock}\n\n${promptText}` : promptText;

    // Mid-turn send (HOY-218): a turn is streaming, so queue the message into that
    // run via enqueue_prompt. It shows as a queued chip (from queueUpdate) until Pi
    // delivers it, then enters the transcript only on restore. Crucially this does
    // NOT open a new channel or re-set the sink: the queued message and the run's
    // single terminal Done keep streaming over the turn's original channel. (A
    // second sendPrompt with the same Channel orphans delivery and freezes the
    // turn.) activeChannels having an entry means a sink is attached.
    if (
      (get().streaming[threadId] ?? false) &&
      activeChannels.has(threadId) &&
      thread.sessionId
    ) {
      try {
        await enqueuePrompt(
          thread.sessionId,
          outbound,
          images,
          behavior ?? "steer",
        );
      } catch (e) {
        set((s) => ({
          threadErrors: { ...s.threadErrors, [threadId]: String(e) },
        }));
      }
      return;
    }

    // Auto-switch to Plan Mode when the message asks for a plan (HOY-291), like
    // Claude Code. Do it here, before the session mode is applied and the prompt
    // streams, so plan mode's system prompt + tool gating shape this very turn.
    // Skipped for the plan-kickoff turn (opts.autoPlanMode === false), and only
    // fires from a non-plan mode so it never fights a user already in plan mode.
    if (
      opts?.autoPlanMode !== false &&
      (thread.permissionMode ?? "default") !== "plan" &&
      detectPlanIntent(text)
    ) {
      await get().setPermissionMode(threadId, "plan");
      pushNotice(threadId, "Switched to Plan Mode to draft a plan first.", "info");
    }

    // Append the user turn plus an in-flight assistant turn the events fold into.
    // Title an untitled thread from its first message.
    set((s) => ({
      turns: {
        ...s.turns,
        [threadId]: [
          ...(s.turns[threadId] ?? []),
          {
            role: "user",
            text,
            ...(hasImages ? { images } : {}),
            ...(contexts.length > 0 ? { contexts } : {}),
          },
          { role: "assistant", blocks: [], streaming: true },
        ],
      },
      streaming: { ...s.streaming, [threadId]: true },
      threadErrors: { ...s.threadErrors, [threadId]: null },
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        updatedAt: Date.now(),
        title:
          th.title === "New thread"
            ? truncateTitle(text || (hasImages ? "Image" : "Context"))
            : th.title,
      })),
    }));

    const stopStreaming = () =>
      set((s) => ({ streaming: { ...s.streaming, [threadId]: false } }));

    try {
      let sessionId = thread.sessionId ?? null;
      if (!sessionId) {
        // Reopen the thread's existing transcript when it has one (e.g. the
        // sidecar was killed on panel close); else start a fresh session.
        // acquireSession dedups with a concurrent hydrateThread so the two never
        // spawn two sidecars for the same thread.
        sessionId = await acquireSession(threadId, project.path ?? "", thread.sessionFile);
        get().setThreadSessionIdInternal(threadId, sessionId);
        // Populate the composer "/" autocomplete now the session exists (HOY-223).
        void get().refreshSlashCommands(threadId);
      }

      // Apply a deferred pick (or adopt the session's model) before the prompt;
      // a failure throws into the catch below so the prompt never rides on a
      // model the user didn't choose. The guard makes repeat calls free.
      await applyThreadModel(threadId, sessionId);
      // Same for a deferred permission mode (HOY-186): the gate must be in
      // place before the prompt streams.
      await applyThreadPermissionMode(threadId, sessionId);
      // Push the global auto-compaction default to the new sidecar (HOY-275).
      // Best-effort inside the helper, so it never blocks the prompt.
      await applyAutoCompaction(sessionId);

      await streamPromptOnThread(threadId, sessionId, outbound, images);
    } catch (e) {
      activeChannels.delete(threadId);
      stopStreaming();
      set((s) => {
        const list = s.turns[threadId] ?? [];
        const last = list[list.length - 1];
        // Render the failure inline on the turn (HOY-214). Fall back to the
        // thread banner only when there is no turn to attach it to.
        if (last && last.role === "assistant") {
          return {
            turns: {
              ...s.turns,
              [threadId]: [
                ...list.slice(0, -1),
                { ...last, streaming: false, error: String(e) },
              ],
            },
          };
        }
        return { threadErrors: { ...s.threadErrors, [threadId]: String(e) } };
      });
    }
  },

  startThread: (projectId, message, opts) => {
    const id = get().addThread(projectId);
    if (opts.model) {
      void get().selectModel(id, opts.model.provider, opts.model.id);
    }
    void get().setPermissionMode(id, opts.permissionMode);
    void get().selectThinkingLevel(id, opts.thinkingLevel);
    void get().submitPrompt(id, message, opts.images);
  },

  stopStreaming: async (threadId) => {
    if (!get().streaming[threadId]) return;
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    try {
      // Rust cancels any pending approval dialog before sending pi's abort, so
      // a blocked tool_call resumes (as a denial) and the abort lands. The
      // aborted turn's error/done events flow back over the channel and reset
      // streaming state and pending cards there.
      await abort(sessionId);
    } catch (e) {
      set((s) => ({
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
    // HOY-300: Rust's cancel_pending_ui already answers *this* thread's own
    // blocked ctx.ui.input as cancelled (the agent tool returns the "stopped"
    // note), but a synchronous child it spawned keeps running independently.
    // Drop the pending-request mapping for any such child and stop it too, so
    // a late child `done` has no live request to answer.
    for (const childId of takeChildRequestsForParent(threadId)) {
      if (get().streaming[childId]) {
        void get().stopStreaming(childId);
      }
    }
  },

  refreshStats: async (threadId) => {
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    try {
      const stats = await getSessionStats(sessionId);
      set((s) => ({ stats: { ...s.stats, [threadId]: stats } }));
      // Capture the durable session file the first time it appears so the thread
      // can be reopened after restart.
      if (stats.sessionFile) {
        const current = findThread(get().projects, threadId)?.thread;
        if (current && current.sessionFile !== stats.sessionFile) {
          set((s) => ({
            projects: patchThread(s.projects, threadId, (th) => ({
              ...th,
              sessionFile: stats.sessionFile,
            })),
          }));
        }
      }
    } catch {
      // Stats are best-effort; a failure leaves the bar on its last value.
    }
  },

  refreshUsage: async () => {
    // Re-reading the whole ~/.hoy/sessions transcript tree is expensive, so skip
    // it when a recent report is already loaded: repeated home <-> panel
    // navigation should not re-walk disk each visit. A short TTL still picks up
    // new usage as the user keeps working.
    const last = get().usageFetchedAt;
    if (get().usageReport && last != null && Date.now() - last < USAGE_TTL_MS) {
      return;
    }
    set({ usageLoading: true });
    try {
      const report = await getUsageStats();
      set({ usageReport: report, usageLoading: false, usageFetchedAt: Date.now() });
    } catch {
      // Best-effort: leave the last report in place and drop the spinner.
      set({ usageLoading: false });
    }
  },

  refreshSlashCommands: async (threadId) => {
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    try {
      const commands = await getCommands(sessionId);
      set((s) => ({
        slashCommands: { ...s.slashCommands, [threadId]: commands },
      }));
    } catch {
      // Best-effort: the composer still offers the /compact built-in.
    }
  },

  refreshSkills: async (projectPath) => {
    const cwd = projectPath ?? "";
    // Dedupe the mount-storm: if a refresh for this cwd is already running, skip.
    if (skillsRefreshInFlight === cwd) return;
    skillsRefreshInFlight = cwd;
    try {
      const { skills } = await listSkills(cwd);
      // Shape skills as slash commands (`skill:<name>`) so the composer's "/" and
      // "@skill:" pickers and the submit-time rewrite treat them like any other
      // command. Names mirror Pi's get_commands skill entries, so a session's
      // get_commands and this disk list dedupe cleanly by name.
      const commands: SlashCommand[] = skills.map((s) => ({
        name: `skill:${s.name}`,
        description: s.description,
        source: "skill",
      }));
      set({ skillCommands: commands });
    } catch {
      // Best-effort: leave the prior skills list; the composer degrades to
      // whatever the session's get_commands provides.
    } finally {
      if (skillsRefreshInFlight === cwd) skillsRefreshInFlight = null;
    }
  },

  refreshSessionTree: async (threadId) => {
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    try {
      const tree = await getTree(sessionId);
      set((s) => ({ sessionTree: { ...s.sessionTree, [threadId]: tree } }));
    } catch {
      // Best-effort: a failure leaves the navigator on its last tree.
    }
  },

  toggleRightDock: (view) => {
    if (get().rightDock === view) {
      set({ rightDock: null });
      return;
    }
    set({ rightDock: view });
    // Opening the tree observes the active thread: prime its slice so it renders
    // now; the on-done refresh keeps the active thread's tree fresh.
    const active = get().activeThreadId;
    if (view === "tree" && active) void get().refreshSessionTree(active);
  },

  closeRightDock: () => set({ rightDock: null }),

  branchFromEntry: async (threadId, entryId) => {
    await branchIntoChildThread(threadId, (sid) => forkSession(sid, entryId), {
      busy: "Finish the current turn before branching.",
      fail: "Branch",
      titlePrefix: "Branch",
      done: (title) => `Branched from "${title}".`,
    });
  },

  cloneThread: async (threadId) => {
    await branchIntoChildThread(threadId, (sid) => cloneSession(sid), {
      busy: "Finish the current turn before cloning.",
      fail: "Clone",
      titlePrefix: "Clone",
      done: (title) => `Cloned "${title}".`,
    });
  },

  openForkPicker: async (threadId) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread?.sessionId) {
      pushNotice(threadId, "Can't fork yet: this thread has no live session.", "error");
      return;
    }
    // get_fork_messages reads the session file; wait for a settled point, matching
    // the branch/clone gate.
    if (get().streaming[threadId]) {
      pushNotice(threadId, "Finish the current turn before forking.", "info");
      return;
    }
    try {
      const { messages } = await getForkMessages(thread.sessionId);
      if (messages.length === 0) {
        pushNotice(threadId, "Nothing to fork from yet: no user messages.", "info");
        return;
      }
      set({ forkPicker: { threadId, messages } });
    } catch (e) {
      pushNotice(threadId, `Fork failed: ${String(e)}`, "error");
    }
  },

  pickFork: (entryId) => {
    const picker = get().forkPicker;
    if (!picker) return;
    set({ forkPicker: null });
    void get().branchFromEntry(picker.threadId, entryId);
  },

  closeForkPicker: () => set({ forkPicker: null }),

  compact: async (threadId, customInstructions) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread?.sessionId) return;
    // Pi rejects compaction mid-turn; gate on idle, and block a double trigger.
    if (get().streaming[threadId] || get().compacting[threadId]) return;
    set((s) => ({ compacting: { ...s.compacting, [threadId]: true } }));
    try {
      const result = await ipcCompact(thread.sessionId, customInstructions);
      const after =
        result.estimatedTokensAfter != null
          ? ` -> ${result.estimatedTokensAfter.toLocaleString()}`
          : "";
      pushNotice(
        threadId,
        `Compacted context: ${result.tokensBefore.toLocaleString()}${after} tokens`,
        "info",
      );
      await get().refreshStats(threadId);
    } catch (e) {
      pushNotice(threadId, `Compaction failed: ${String(e)}`, "error");
    } finally {
      set((s) => ({ compacting: { ...s.compacting, [threadId]: false } }));
    }
  },

  // Goal Mode (HOY-263) command actions. Dispatched from submitPrompt's /goal
  // intercept above; none of these send anything to Pi except via the normal
  // submitPrompt path (setGoal's kickoff prompt, resumeGoal's continuation).
  setGoal: async (threadId, condition, opts) => {
    if (!findThread(get().projects, threadId)) return;
    // tokensBaseline anchors the goal's usage delta to the thread's current
    // token total (the same per-thread counter the context bar reads via
    // stats[threadId].tokens.total, kept fresh by refreshStats/getSessionStats)
    // so nextGoalAction's tokensUsed reflects only usage since the goal started.
    const tokensBaseline = get().stats[threadId]?.tokens.total ?? 0;
    const goal: ThreadGoal = {
      condition,
      status: "active",
      turns: 0,
      tokensBaseline,
      tokensUsed: 0,
      startedAt: Date.now(),
      capTurns: GOAL_DEFAULT_CAP_TURNS,
      // HOY-298/HOY-299: carry the parsed verify command and evaluator kind onto
      // the goal so the loop's command gate and auditor gate see them (and they
      // persist via WsGoal). Omitted when absent so a plain /goal stays pure v1.
      ...(opts?.verifyCommand ? { verifyCommand: opts.verifyCommand } : {}),
      ...(opts?.evaluatorKind ? { evaluatorKind: opts.evaluatorKind } : {}),
    };
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({ ...th, goal })),
    }));
    pushNotice(threadId, `Goal set: "${condition}"`, "info");
    // Sent through the normal path so session spawn, permission mode, and
    // auto-compaction all apply exactly as they would for any other prompt.
    // Awaited so submitPrompt's own promise (and thus the /goal intercept
    // above) only resolves once this kickoff turn is actually underway.
    await get().submitPrompt(threadId, condition);
  },

  pauseGoal: (threadId) => {
    const goal = findThread(get().projects, threadId)?.thread.goal;
    if (!goal) return;
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) =>
        th.goal ? { ...th, goal: { ...th.goal, status: "paused" } } : th,
      ),
    }));
    pushNotice(threadId, "Goal paused.", "info");
  },

  resumeGoal: async (threadId) => {
    const goal = findThread(get().projects, threadId)?.thread.goal;
    if (!goal || (goal.status !== "paused" && goal.status !== "capped")) return;
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) =>
        th.goal ? { ...th, goal: { ...th.goal, status: "active" } } : th,
      ),
    }));
    pushNotice(threadId, "Goal resumed.", "info");
    // Re-arm to active above and send the continuation prompt through the same
    // helper the done-handler loop uses, so a user resume and an auto-continue
    // read identically in the transcript. A capped/paused goal may carry a
    // lastReason from a prior evaluation; fall back to a manual-resume note when
    // it does not. The done handler drives the rest of the evaluate/continue
    // cycle once this continuation turn ends.
    await sendGoalContinuation(
      threadId,
      goal.condition,
      goal.lastReason ?? "resumed by user",
    );
  },

  clearGoal: (threadId) => {
    const goal = findThread(get().projects, threadId)?.thread.goal;
    if (!goal) return;
    // status: "cleared" mirrors restoreGoal's drop semantics (a cleared goal
    // is never restored), so removing the field outright is equivalent to,
    // and simpler than, persisting a cleared goal.
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        goal: undefined,
      })),
    }));
    pushNotice(threadId, "Goal cleared.", "info");
  },

  showGoalStatus: (threadId) => {
    const goal = findThread(get().projects, threadId)?.thread.goal;
    if (!goal) {
      pushNotice(threadId, "No goal set for this thread.", "info");
      return;
    }
    const elapsed = formatElapsed(Date.now() - goal.startedAt);
    const reason = goal.lastReason ? ` - ${goal.lastReason}` : "";
    pushNotice(
      threadId,
      `Goal (${goal.status}): "${goal.condition}" - turn ${goal.turns}/${goal.capTurns}, ${goal.tokensUsed.toLocaleString()} tokens, ${elapsed}${reason}`,
      "info",
    );
  },

  setAutoCompaction: async (enabled) => {
    // Fan the pref out to every currently-live session. autoCompactionApplied
    // holds exactly those sessionIds (added on spawn, dropped on release), so it
    // is the live-session registry. Best-effort, matching applyAutoCompaction: a
    // per-session RPC hiccup must not revert the global pref or raise a thread
    // error, since Pi persists the value globally and the next spawn re-applies.
    await Promise.allSettled(
      [...autoCompactionApplied].map((sessionId) =>
        ipcSetAutoCompaction(sessionId, enabled),
      ),
    );
  },

  // Internal: pin a thread to the sidecar session it spawned. Not part of the
  // public action surface, just shared between submitPrompt and (later) restore.
  setThreadSessionIdInternal: (threadId: string, sessionId: string) =>
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        sessionId,
      })),
    })),

  // Load the persisted projects -> threads tree on boot, then enable autosave.
  initWorkspace: async () => {
    try {
      const ws = await loadWorkspace();
      // Backfill for workspaces saved before the renamed flag existed: a
      // custom title on a never-prompted thread can only have come from a
      // manual rename, and without the flag the untouched filter would drop
      // it. Threads with a transcript are protected by sessionFile already.
      const drafts: Record<string, string> = {};
      const projects = (ws.projects ?? []).map((p) => ({
        ...p,
        threads: p.threads.map((t) => {
          // Drafts live in the drafts slice, not on the in-memory thread.
          const { draft, goal, ...rest } = t;
          if (draft) drafts[rest.id] = draft;
          const restoredGoal = restoreGoal(goal);
          const withGoal = restoredGoal ? { ...rest, goal: restoredGoal } : rest;
          return !withGoal.renamed && !withGoal.sessionFile && withGoal.title !== "New thread"
            ? { ...withGoal, renamed: true }
            : withGoal;
        }),
      }));
      // Restore the last worked-in project only if it still exists.
      const activeProjectId = projects.some((p) => p.id === ws.activeProjectId)
        ? (ws.activeProjectId ?? null)
        : null;
      set({ projects, drafts, activeProjectId });
    } catch {
      // Corrupt/unreadable workspace: start empty rather than block the app.
    } finally {
      hydrated = true;
    }
  },

  // Restore a reopened thread's transcript. HOY-287: paint the transcript from
  // disk FIRST (parse the session JSONL with no sidecar, effectively instant),
  // THEN spawn the sidecar, pull the live messages, and silently reconcile. No-op
  // for a brand-new thread (no sessionFile -> spawns lazily on first prompt) or one
  // already live/loaded.
  hydrateThread: async (threadId) => {
    const found = findThread(get().projects, threadId);
    if (!found) return;
    const { thread, project } = found;
    if (!thread.sessionFile || thread.sessionId) return;
    if ((get().turns[threadId]?.length ?? 0) > 0) return;

    // 1. Instant disk render. Keep the exact array reference we paint so the
    // reconcile below can tell "still our disk render" (safe to replace) apart
    // from "a concurrent submitPrompt replaced it" (must win). submitPrompt always
    // spreads a new array, so identity distinguishes the two.
    let diskTurns: Turn[] | null = null;
    try {
      const diskMessages = await readSessionTranscript(thread.sessionFile);
      // Only paint if nothing populated turns while we read (a concurrent
      // submitPrompt wins); an empty transcript leaves turns untouched.
      if ((get().turns[threadId]?.length ?? 0) === 0 && diskMessages.length > 0) {
        diskTurns = messagesToTurns(diskMessages);
        const painted = diskTurns;
        set((s) => ({ turns: { ...s.turns, [threadId]: painted } }));
      }
    } catch {
      // Best-effort: a failed disk read just means no early paint; the sidecar
      // path below still restores the transcript.
    }

    // A concurrent submitPrompt could have populated turns while we read from
    // disk. Its live/streaming turns must win, so don't clobber and don't
    // re-render from disk: it will spawn the sidecar itself. (turns present, not
    // our disk array -> a real prompt got there first.)
    const afterDisk = get().turns[threadId];
    if (afterDisk && afterDisk !== diskTurns && afterDisk.length > 0) return;

    try {
      const sessionId = await acquireSession(
        threadId,
        project.path ?? "",
        thread.sessionFile,
      );
      get().setThreadSessionIdInternal(threadId, sessionId);
      // Populate the composer "/" autocomplete for the restored session (HOY-223).
      void get().refreshSlashCommands(threadId);
      // Reconcile the thread's model and permission mode with the restored
      // session off the critical path; hydration must not block the
      // transcript restore.
      void applyThreadModel(threadId, sessionId).catch((e) => {
        set((s) => ({
          threadErrors: { ...s.threadErrors, [threadId]: String(e) },
        }));
      });
      void applyThreadPermissionMode(threadId, sessionId).catch((e) => {
        set((s) => ({
          threadErrors: { ...s.threadErrors, [threadId]: String(e) },
        }));
      });
      // Push the global auto-compaction default to the restored session
      // (HOY-275), off the critical path; the helper is best-effort.
      void applyAutoCompaction(sessionId);
      // A concurrent submitPrompt may have populated turns and sent a prompt
      // while we were spawning; don't clobber it with the restored transcript.
      // The disk render we painted is ours to replace, so only bail when turns
      // exist AND are not our disk array (a real prompt's turns win).
      const beforeFetch = get().turns[threadId];
      if (beforeFetch && beforeFetch !== diskTurns && beforeFetch.length > 0) {
        return;
      }
      const messages = await getMessages(sessionId);
      // Align entry ids so tree-node clicks can scroll here (HOY-304). Best-effort
      // and off the transcript's critical shape: undefined just means unaddressed.
      const entryIds = await entryIdsFor(sessionId, messages.length);
      const beforeSet = get().turns[threadId];
      if (beforeSet && beforeSet !== diskTurns && beforeSet.length > 0) return;
      set((s) => ({
        turns: { ...s.turns, [threadId]: messagesToTurns(messages, entryIds) },
      }));
      void get().refreshStats(threadId);
    } catch (e) {
      set((s) => ({
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
  },

  // Persisted through the autosave (title and the renamed flag are in the
  // workspace allowlist). The flag marks the thread as user work so it is
  // never discarded as untouched.
  renameThread: (threadId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        title: trimmed,
        renamed: true,
      })),
    }));
  },

  archiveThread: (threadId) => {
    // Cascade first so a child is never left rootless when its parent is
    // filtered out of the tree; archiveThread on each child reuses the same
    // untouched-delete + closePanel teardown. HOY-238.
    for (const childId of childThreadIdsOf(get().projects, threadId)) {
      get().archiveThread(childId);
    }
    // An untouched thread has nothing worth keeping in history; archiving it
    // deletes it instead.
    const found = findThread(get().projects, threadId);
    if (found && isUntouched(found.thread, get().turns, get().drafts)) {
      get().deleteThread(threadId);
      return;
    }
    get().closePanel(threadId); // kills the sidecar and clears cached turns
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        archived: true,
      })),
    }));
    // HOY-245: an archived thread must never start or hold a slot. Purge it from
    // the limiter, then pump in case a freed slot lets a still-live queued agent
    // start. The cascade above visits each descendant, so each is purged.
    purgeFromLimiter(threadId);
    get().pumpAgentQueue();
  },

  unarchiveThread: (threadId) =>
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        archived: false,
      })),
    })),

  deleteThread: (threadId) => {
    // Cascade first so a child is never left rootless when its parent is
    // removed from the tree. HOY-238.
    for (const childId of childThreadIdsOf(get().projects, threadId)) {
      get().deleteThread(childId);
    }
    const thread = findThread(get().projects, threadId)?.thread;
    if (thread?.sessionId) releaseSession(thread.sessionId);
    if (thread?.sessionFile) void deleteSessionFile(thread.sessionFile);
    get().closePanel(threadId);
    set((s) => {
      const { [threadId]: _d, ...drafts } = s.drafts;
      return {
        drafts,
        projects: s.projects.map((p) => ({
          ...p,
          threads: p.threads.filter((t) => t.id !== threadId),
        })),
      };
    });
    // HOY-245: same purge as archive. A deleted subtree never starts or leaks a
    // slot; the cascade above visits each descendant.
    purgeFromLimiter(threadId);
    get().pumpAgentQueue();
  },
}));

// Reactive "does this thread have a live fleet" for the model glyph's fleet color
// (HOY-302). Selector returns a boolean, so a row only re-renders when its fleet
// flips between running and idle, not on every streaming token.
export function useThreadHasRunningSubagents(threadId: string): boolean {
  return useSessionStore((s) =>
    threadHasRunningSubagents(
      s.projects,
      s.streaming,
      s.runningAgents,
      s.agentQueue,
      threadId,
    ),
  );
}

// Dedup concurrent session spawns for one thread: openThread fires hydrateThread
// while the user may submitPrompt before it resolves. Sharing the in-flight
// promise means both get the same sidecar instead of spawning (and leaking) two.
const pendingSessions = new Map<string, Promise<string>>();

// The project cwd whose skills refresh is currently in flight (HOY-323), or null.
// refreshSkills spawns a one-shot sidecar, and ThreadView + HomeComposer both
// fire it on mount for the same project (home -> thread hands off in a moment);
// deduping concurrent refreshes for the same cwd avoids a redundant spawn. A
// later refresh (after the in-flight one resolves) still re-reads disk.
let skillsRefreshInFlight: string | null = null;

// The channel currently streaming a turn for each thread. Used to ignore trailing
// events from a channel whose thread has moved on (panel closed, or a newer turn
// started). Entry is dropped on done / close / send failure.
const activeChannels = new Map<string, Channel<AgentEvent>>();

// HOY-263: threads with a goal continuation in flight (the evaluate -> continue
// step of the done-handler loop). At most one per thread: a double `done`
// (which can arrive for one turn) must not start two evaluators or two
// continuation sends. Added at the top of maybeContinueGoal before any await,
// cleared in its finally.
const continuationPending = new Set<string>();

// HOY-292: coalesce high-frequency streaming deltas (text + reasoning) into one
// state write per animation frame instead of one per token. Pi emits these many
// times a second; a setState per token re-renders the streaming turn (and, before
// this ticket's memoization, the whole transcript) on every token, and makes the
// markdown renderer re-parse the growing tail block O(n) times per turn. Buffering
// per rAF collapses a burst of tokens into a single render/parse while keeping the
// stream visually live. Only text/reasoning are buffered; every structural event
// (tool, permission, done, ...) flushes the buffer first so ordering is exact.
const streamDeltaBuffers = new Map<string, AgentEvent[]>();
const streamFlushScheduled = new Set<string>();

function flushStreamDeltas(threadId: string): void {
  const buffered = streamDeltaBuffers.get(threadId);
  if (!buffered || buffered.length === 0) return;
  streamDeltaBuffers.set(threadId, []);
  useSessionStore.setState((s) => {
    const current = s.turns[threadId];
    if (!current) return {};
    let next = current;
    for (const event of buffered) next = applyEvent(next, event);
    return { turns: { ...s.turns, [threadId]: next } };
  });
}

function scheduleStreamFlush(threadId: string): void {
  if (streamFlushScheduled.has(threadId)) return;
  streamFlushScheduled.add(threadId);
  requestAnimationFrame(() => {
    streamFlushScheduled.delete(threadId);
    flushStreamDeltas(threadId);
  });
}

// The run body of a subagent's INITIAL spawn (HOY-245). Split out of
// spawnChildThread so both the immediate-start path (a free slot) and the pump
// path (a slot freed later) drive an identical run: seed the in-flight assistant
// turn, acquire a session, reconcile model/permission mode, then stream. Seeding
// lives here so a queued child gets its streaming turn only when it actually
// starts, not while it waits.
async function startChildRun(
  childId: string,
  payload: SpawnPayload,
  childDepth: number,
): Promise<void> {
  const found = findThread(useSessionStore.getState().projects, childId);
  // Torn down between enqueue and start: nothing to run. Release the slot the
  // caller took before returning, or it leaks (no channel wired, no done fires).
  if (!found) {
    releaseAgentSlot(childId);
    return;
  }
  const { project, thread: child } = found;
  const parent = child.parentThreadId
    ? findThread(useSessionStore.getState().projects, child.parentThreadId)?.thread
    : undefined;
  useSessionStore.setState((s) => ({
    // Seed the in-flight assistant turn streamPromptOnThread folds events into;
    // applyEvent is a no-op unless the last turn is an assistant turn. The user
    // turn was seeded at insert time, so replace to the full [user, assistant].
    turns: {
      ...s.turns,
      [childId]: [
        { role: "user", text: payload.task },
        { role: "assistant", blocks: [], streaming: true },
      ],
    },
    streaming: { ...s.streaming, [childId]: true },
  }));
  try {
    const cwd = project.path ?? "";
    // HOY-244: if the child's type opts into inherit_context, fork it from the
    // parent's transcript. Only when the parent has an established session file;
    // a child spawned before the parent has one has no meaningful context to
    // inherit, so it starts fresh. The sidecar also gates on the env being set.
    const childDef = useSessionStore
      .getState()
      .subagents.find((d) => d.name === payload.subagentType);
    const inheritFrom =
      childDef?.inheritContext && parent?.sessionFile ? parent.sessionFile : null;
    const sessionId = await createSession(
      cwd,
      null,
      payload.subagentType,
      parent?.permissionMode ?? null,
      childDepth,
      usePrefsStore.getState().requireSubagentApproval,
      inheritFrom,
    );
    useSessionStore.setState((s) => ({
      projects: patchThread(s.projects, childId, (t) => ({ ...t, sessionId })),
    }));
    // Same reconcile as submitPrompt: apply the (possibly inherited) model and
    // permission mode before the prompt streams.
    await applyThreadModel(childId, sessionId);
    await applyThreadPermissionMode(childId, sessionId);
    // Subagents honor the same global auto-compaction default (HOY-275).
    await applyAutoCompaction(sessionId);
    await streamPromptOnThread(childId, sessionId, payload.task);
  } catch (e) {
    useSessionStore.setState((s) => ({
      streaming: { ...s.streaming, [childId]: false },
      threadErrors: {
        ...s.threadErrors,
        [childId]: String(e instanceof Error ? e.message : e),
      },
    }));
    // A createSession / applyThread* failure wires no channel, so no done ever
    // fires and the done-path release cannot run: release the slot here or it
    // leaks forever (HOY-245). Idempotent with the done-path release (both guard
    // on membership), so a later done is a harmless no-op.
    releaseAgentSlot(childId);
  }
}

// Release a subagent's concurrency slot (HOY-245) and pump the queue. Mirrors
// the done-path release: guarded on membership so it is idempotent, callable
// from any termination path (done, startChildRun error / early return) without
// double-releasing.
// HOY-247: the live concurrency cap. Its default lives in limits.ts and seeds
// the maxConcurrentAgents pref; the pref is the effective value, clamped to at
// least 1 so a malformed stored value can never stall spawns. The depth cap
// stays a hard constant (a tunable depth would weaken the fork-bomb guard).
function concurrencyCap(): number {
  const n = usePrefsStore.getState().maxConcurrentAgents;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : MAX_CONCURRENT_AGENTS;
}

function releaseAgentSlot(threadId: string): void {
  if (!useSessionStore.getState().runningAgents.has(threadId)) return;
  useSessionStore.setState((s) => {
    const runningAgents = new Set(s.runningAgents);
    runningAgents.delete(threadId);
    return { runningAgents };
  });
  useSessionStore.getState().pumpAgentQueue();
}

// Remove a torn-down thread from the concurrency limiter (HOY-245) so it never
// starts and never leaks a slot. Callers pump after to fill a freed slot.
function purgeFromLimiter(threadId: string): void {
  useSessionStore.setState((s) => {
    const patch: Partial<SessionStore> = {};
    if (
      s.runningAgents.has(threadId) ||
      s.agentQueue.includes(threadId) ||
      threadId in s.queuedPayloads
    ) {
      const runningAgents = new Set(s.runningAgents);
      runningAgents.delete(threadId);
      const { [threadId]: _dropped, ...queuedPayloads } = s.queuedPayloads;
      patch.runningAgents = runningAgents;
      patch.agentQueue = s.agentQueue.filter((id) => id !== threadId);
      patch.queuedPayloads = queuedPayloads;
    }
    return patch;
  });
  // HOY-300: if this torn-down thread was a synchronous child still awaiting
  // (closePanel/archive/delete killed its sidecar before its `done`), drop its
  // pending-request mapping so it can't leak. Its blocked parent request is left
  // for Rust's cancel_pending_ui / a stale-id no-op; nothing else reads the entry.
  takeSubagentRequest(threadId);
}

// Wire a per-turn Channel to `threadId` and stream a prompt over it. Shared by
// submitPrompt (a user-submitted turn) and spawnChildThread (a subagent's
// turn, HOY-231), so a child thread streams through the exact same event
// handling as any other thread. Module-level (outside the store creator), so
// it uses useSessionStore.getState()/setState() in place of the creator's
// bound get()/set(); those are the same functions under the hood.
async function streamPromptOnThread(
  threadId: string,
  sessionId: string,
  message: string,
  images?: ImageContent[],
): Promise<void> {
  const stopStreaming = () =>
    useSessionStore.setState((s) => ({
      streaming: { ...s.streaming, [threadId]: false },
    }));

  const channel = new Channel<AgentEvent>();
  activeChannels.set(threadId, channel);
  channel.onmessage = (event) => {
    // Ignore events from a superseded channel: closing a panel kills the
    // sidecar, which makes the reader emit a (now-expected) error + done over
    // this channel. Without this guard that stale error would resurface as a
    // banner and orphaned turns when the thread is reopened.
    if (activeChannels.get(threadId) !== channel) return;
    // HOY-292: buffer the high-frequency text/reasoning deltas and apply them on
    // the next animation frame (one render per frame instead of one per token).
    // These carry no side effects beyond folding into the transcript, so batching
    // is safe; the visual delay is at most a frame.
    if (event.kind === "text" || event.kind === "reasoning") {
      const buffered = streamDeltaBuffers.get(threadId) ?? [];
      buffered.push(event);
      streamDeltaBuffers.set(threadId, buffered);
      scheduleStreamFlush(threadId);
      return;
    }
    // Every other event is structural (tool, permission, done, ...) and its
    // handling below reads the transcript, so flush any buffered deltas first to
    // preserve exact event ordering before this event folds in.
    flushStreamDeltas(threadId);
    // HOY-300: the agent tool blocked on ctx.ui.input for a synchronous spawn.
    // The child must be able to answer the parent's blocked request once it is
    // done, so the parent must be live (have a sessionId) to have issued it.
    if (event.kind === "subagentSpawnSync") {
      const parentSessionId = findThread(
        useSessionStore.getState().projects,
        threadId,
      )?.thread.sessionId;
      if (!parentSessionId) return; // parent must be live to have issued the request
      // HOY-300: this parent is about to block on the child's result. If it holds
      // a concurrency slot (it is itself a running subagent), release it so the
      // child can start even under a full cap — a blocked agent isn't computing.
      if (useSessionStore.getState().runningAgents.has(threadId)) {
        useSessionStore.setState((s) => {
          const runningAgents = new Set(s.runningAgents);
          runningAgents.delete(threadId);
          return { runningAgents };
        });
        useSessionStore.getState().pumpAgentQueue();
      }
      void useSessionStore.getState().spawnChildThread(threadId, {
        agentId: event.agentId,
        subagentType: event.subagentType,
        task: event.task,
        requestId: event.requestId,
      });
      return;
    }
    useSessionStore.setState((s) => ({
      turns: {
        ...s.turns,
        [threadId]: applyEvent(s.turns[threadId] ?? [], event),
      },
    }));
    if (event.kind === "permissionRequest") {
      const { kind: _k, ...request } = event;
      useSessionStore.setState((s) => {
        let turns = s.turns;
        // HOY-199: mark the tool block awaiting approval so the user sees
        // what the tool will do (the diff) before deciding. The block was
        // created by the tool `start` event that precedes this request.
        if (request.toolCallId) {
          turns = {
            ...turns,
            [threadId]: markToolPending(
              turns[threadId] ?? [],
              request.toolCallId,
              request.toolName,
              request.toolArgs,
            ),
          };
        }
        return {
          turns,
          pendingPermissions: {
            ...s.pendingPermissions,
            [threadId]: [
              ...(s.pendingPermissions[threadId] ?? []),
              request,
            ],
          },
        };
      });
    } else if (event.kind === "done") {
      activeChannels.delete(threadId);
      stopStreaming();
      // A turn cannot end with a dialog still blocking it; drop any
      // leftovers so no orphaned card survives the turn. Also remove
      // pending tool blocks that were never replaced (HOY-199).
      useSessionStore.setState((s) => {
        const turns = s.turns[threadId];
        if (!turns) return { pendingPermissions: { ...s.pendingPermissions, [threadId]: [] } };
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant") {
          const filtered = { ...last, blocks: last.blocks.filter((b) => b.kind !== "tool" || !b.tool.pending) };
          // A delivered steer/follow-up opens a fresh assistant turn; if the
          // run ended before it produced anything, drop the empty shell so no
          // blank bubble is left behind.
          const isEmpty =
            filtered.blocks.length === 0 &&
            !filtered.reasoning &&
            !filtered.error &&
            !filtered.aborted;
          const nextTurns = isEmpty
            ? turns.slice(0, -1)
            : [...turns.slice(0, -1), filtered];
          return {
            turns: { ...s.turns, [threadId]: nextTurns },
            pendingPermissions: { ...s.pendingPermissions, [threadId]: [] },
          };
        }
        return { pendingPermissions: { ...s.pendingPermissions, [threadId]: [] } };
      });
      void useSessionStore.getState().refreshStats(threadId);
      // HOY-279/280: a completed turn appends entries, so keep the `/tree`
      // navigator fresh — but only when the dock is open and showing THIS thread
      // (it follows the active thread). Otherwise the get_tree call is wasted.
      {
        const s = useSessionStore.getState();
        if (s.rightDock === "tree" && s.activeThreadId === threadId) {
          void s.refreshSessionTree(threadId);
        }
      }
      // HOY-245: release this thread's concurrency slot on its INITIAL run's
      // first done. Membership in runningAgents is what marks an initial run;
      // resume runs (a delivered child resuming its parent) and foreground turns
      // are not in the set, so this is a no-op for them. Free the slot before
      // delivery so a still-queued sibling can start immediately.
      if (useSessionStore.getState().runningAgents.has(threadId)) {
        useSessionStore.setState((s) => {
          const runningAgents = new Set(s.runningAgents);
          runningAgents.delete(threadId);
          return { runningAgents };
        });
        useSessionStore.getState().pumpAgentQueue();
      }
      // HOY-300: a finished child answers its parent's blocked agent-tool
      // request in-band (replacing the HOY-233 turn-injection delivery below).
      respondSubagentResult(threadId);
      // HOY-213: a plan-mode turn that produced a proposed_plan block raises the
      // "Plan ready" handoff card.
      flagPlanReadyIfPresent(threadId);
      // HOY-263: if this thread is running an active goal, decide the next step
      // (pause/cap/evaluate-and-continue) now that the turn has ended. Fire and
      // forget: its evaluator call is async and every failure is handled inside,
      // so it must never block or throw back into this event handler.
      void maybeContinueGoal(threadId, sessionId);
    } else if (event.kind === "queueUpdate") {
      // Pi sends the full queue arrays each time; replace, don't append. The
      // chips reflect what is still queued; anything that left the queue was
      // delivered into the run, so render it as a user turn followed by a
      // fresh assistant turn (HOY-218). This keeps the live transcript in
      // order and identical to a reloaded thread.
      useSessionStore.setState((s) => {
        const prev = s.queued[threadId] ?? { steering: [], followUp: [] };
        const delivered = [
          ...removedItems(prev.steering, event.steering),
          ...removedItems(prev.followUp, event.followUp),
        ];
        const queued = {
          ...s.queued,
          [threadId]: {
            steering: event.steering,
            followUp: event.followUp,
          },
        };
        if (delivered.length === 0) return { queued };
        const list = s.turns[threadId] ?? [];
        const closed = list.map((t, i) =>
          i === list.length - 1 && t.role === "assistant"
            ? { ...t, streaming: false }
            : t,
        );
        const appended: Turn[] = [
          ...closed,
          ...delivered.map((deliveredText) => ({
            role: "user" as const,
            text: deliveredText,
          })),
          { role: "assistant" as const, blocks: [], streaming: true },
        ];
        return { queued, turns: { ...s.turns, [threadId]: appended } };
      });
    } else if (event.kind === "notify") {
      // Transient notice; auto-expire so it does not pile up (ext UI).
      const id = ++noticeSeq;
      useSessionStore.setState((s) => ({
        notices: {
          ...s.notices,
          [threadId]: [
            ...(s.notices[threadId] ?? []),
            { id, message: event.message, type: event.notifyType ?? "info" },
          ],
        },
      }));
      setTimeout(() => useSessionStore.getState().dismissNotice(threadId, id), NOTICE_TTL_MS);
    } else if (event.kind === "setStatus") {
      // Keyed footer status; an absent statusText clears that key.
      useSessionStore.setState((s) => {
        const thread = { ...(s.statuses[threadId] ?? {}) };
        if (event.statusText === undefined) delete thread[event.statusKey];
        else thread[event.statusKey] = event.statusText;
        return { statuses: { ...s.statuses, [threadId]: thread } };
      });
    } else if (event.kind === "setWidget") {
      // Keyed composer widget; absent widgetLines clears that key.
      useSessionStore.setState((s) => {
        const thread = { ...(s.widgets[threadId] ?? {}) };
        if (event.widgetLines === undefined) delete thread[event.widgetKey];
        else
          thread[event.widgetKey] = {
            lines: event.widgetLines,
            placement: event.widgetPlacement ?? "aboveEditor",
          };
        return { widgets: { ...s.widgets, [threadId]: thread } };
      });
    } else if (event.kind === "setTitle") {
      void getCurrentWindow().setTitle(event.title);
    } else if (event.kind === "setEditorText") {
      useSessionStore.getState().setDraft(threadId, event.text);
    } else if (event.kind === "tool" && event.phase === "end") {
      // Tool output is added to context, so the usage bar slides (HOY-208).
      void useSessionStore.getState().refreshStats(threadId);
    } else if (event.kind === "status" && event.label === "compacting") {
      // Compaction rewrites context; refresh after it's done (the next
      // text/tool event will update the bar; this is a best-effort interim).
      void useSessionStore.getState().refreshStats(threadId);
    } else if (event.kind === "compactionEnd") {
      // Auto-path compaction finished (threshold/overflow). Clear the manual
      // flag defensively, refresh the usage meter, and surface an honest
      // notice; failures are shown, not swallowed (HOY-229).
      useSessionStore.setState((s) => ({ compacting: { ...s.compacting, [threadId]: false } }));
      if (event.aborted || event.errorMessage) {
        pushNotice(
          threadId,
          `Compaction ${event.aborted ? "aborted" : "failed"}${
            event.errorMessage ? `: ${event.errorMessage}` : ""
          }`,
          "error",
        );
      } else {
        const after =
          event.estimatedTokensAfter != null
            ? ` -> ${event.estimatedTokensAfter.toLocaleString()}`
            : "";
        const before =
          event.tokensBefore != null
            ? `${event.tokensBefore.toLocaleString()}${after} tokens`
            : "context";
        pushNotice(threadId, `Compacted ${before}`, "info");
      }
      void useSessionStore.getState().refreshStats(threadId);
    } else if (event.kind === "sessionStart") {
      // The sidecar rebound to a new session file (fork/clone, HOY-282). The
      // event omits the new path, so refresh stats to repoint Thread.sessionFile
      // (getSessionStats carries it), and refresh the tree if this thread's
      // navigator is open.
      void useSessionStore.getState().refreshStats(threadId);
      const s = useSessionStore.getState();
      if (s.rightDock === "tree" && s.activeThreadId === threadId) {
        void s.refreshSessionTree(threadId);
      }
    }
  };

  await sendPrompt(sessionId, message, channel, images);
}

// HOY-263: the message that re-drives an active goal for another turn. Kept
// short and visually distinct so the transcript shows why the loop kept going,
// and deliberately does NOT begin with "/goal", so even a condition that starts
// with "/goal" cannot bounce this continuation back into the /goal intercept.
function goalContinuationPrompt(condition: string, reason: string): string {
  return (
    `Keep working toward the goal: ${condition}.\n` +
    `Evaluator (not yet met): ${reason}.\n` +
    "Continue with the next concrete step; do not stop until it is demonstrably met."
  );
}

// HOY-298: cap on the verify-command output tail folded into a continuation
// reason. Task A already tail-bounds each stream to ~8000 chars; this keeps the
// combined snippet from bloating the transcript.
const VERIFY_REASON_MAX_CHARS = 1500;

// HOY-298: build the continuation reason for a FAILED verify gate. Leads with the
// exit code and command, then a bounded tail of the combined stdout+stderr so the
// model sees why the deterministic check failed without swamping the transcript.
function buildVerifyFailReason(
  command: string,
  verify: GoalVerifyResult,
): string {
  const combined = [verify.stdout, verify.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  const tail =
    combined.length > VERIFY_REASON_MAX_CHARS
      ? `...${combined.slice(combined.length - VERIFY_REASON_MAX_CHARS)}`
      : combined;
  return (
    `Verify command failed (exit ${verify.code}): ${command}` +
    (tail ? `\n${tail}` : "")
  );
}

// HOY-263: send the continuation through the normal submitPrompt path (a fresh
// per-prompt sink), shared by resumeGoal (a user resume) and the done-handler
// loop (an auto-continue) so both read identically in the transcript. A second
// sendPrompt on a still-live channel would orphan delivery, so this must go via
// submitPrompt, which opens a new turn.
async function sendGoalContinuation(
  threadId: string,
  condition: string,
  reason: string,
): Promise<void> {
  await useSessionStore
    .getState()
    .submitPrompt(threadId, goalContinuationPrompt(condition, reason));
}

// HOY-263: immutably patch the live thread's goal. No-op if the goal is gone.
function patchGoal(threadId: string, patch: Partial<ThreadGoal>): void {
  useSessionStore.setState((s) => ({
    projects: patchThread(s.projects, threadId, (th) =>
      th.goal ? { ...th, goal: { ...th.goal, ...patch } } : th,
    ),
  }));
}

// HOY-263: the renderer-owned goal continuation loop. Runs after a turn's `done`
// cleanup: if the finished thread is running an active goal, the pure
// nextGoalAction reducer decides the next step from the turn outcome, and only
// the evaluate branch does anything async/effectful. Fire-and-forget from the
// done handler; every failure (including a rejected evaluator) is contained here
// so nothing throws back into the event stream and the loop never falsely stops.
async function maybeContinueGoal(
  threadId: string,
  sessionId: string,
): Promise<void> {
  // Idempotency against a double `done` for one turn: at most one continuation
  // in flight per thread. Set-and-check straddles the awaits below, so a second
  // done that arrives before this one resolves is dropped rather than starting a
  // second evaluate / continuation send.
  if (continuationPending.has(threadId)) return;

  const goal = findThread(useSessionStore.getState().projects, threadId)?.thread
    .goal;
  if (!goal || goal.status !== "active") return;

  // Reserve the single-continuation slot before the first await (refreshStats),
  // so a done arriving during that await sees it and bails. Held across the
  // whole decision, including the evaluator call, and cleared in the finally.
  continuationPending.add(threadId);
  try {
    // Turn outcome (Task 1 TurnOutcome). `aborted`/`errored` come from the
    // finished turn's last assistant bubble (the done cleanup keeps its
    // aborted/error flags); `hasPendingUserPrompt` from Pi's steer/follow-up
    // queue for this thread, so a message the user typed mid-turn runs before
    // the next auto-continuation (nextGoalAction yields).
    const state = useSessionStore.getState();
    const turns = state.turns[threadId] ?? [];
    let aborted = false;
    let errored = false;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant") {
        aborted = !!t.aborted;
        errored = !!t.error;
        break;
      }
    }
    const q = state.queued[threadId];
    const hasPendingUserPrompt =
      !!q && (q.steering.length > 0 || q.followUp.length > 0);
    // Refresh stats so tokensNow reflects this turn's usage: the done handler's
    // own refreshStats is fire-and-forget, so await a fresh read here. Falls
    // back to the goal's last known total if the read yields nothing.
    await useSessionStore.getState().refreshStats(threadId);
    const tokensNow =
      useSessionStore.getState().stats[threadId]?.tokens.total ??
      goal.tokensBaseline + goal.tokensUsed;

    const action = nextGoalAction(goal, {
      aborted,
      errored,
      hasPendingUserPrompt,
      tokensNow,
    });

    switch (action.type) {
      case "none":
      case "yield":
        // none: not our turn to act. yield: leave the goal active so the
        // queued user prompt runs; the loop re-checks after that turn ends.
        return;
      case "pause":
        // An aborted/errored turn parks the goal until the user resumes.
        patchGoal(threadId, { status: "paused" });
        pushNotice(threadId, "Goal paused (turn stopped).", "info");
        return;
      case "cap":
        patchGoal(threadId, { status: "capped", turns: action.turns });
        pushNotice(
          threadId,
          `Goal hit its ${goal.capTurns}-turn cap; resume to keep going.`,
          "info",
        );
        return;
      case "evaluate": {
        let res: EvaluationResult;
        try {
          res = await evaluateGoal(
            sessionId,
            goal.condition,
            goal.evaluatorModel,
          );
        } catch (e) {
          // Fail-open across the IPC seam (Task 2 review): evaluateGoal fails
          // open to met:false INSIDE the sidecar, but the Rust command still
          // REJECTS on infrastructure failure (no live sidecar, spawn failure,
          // non-zero exit, unparseable stdout). Treat a rejection exactly like
          // an unmet verdict so the loop keeps working rather than throwing or
          // falsely stopping the goal.
          res = { met: false, reason: `evaluator error: ${String(e)}` };
        }
        // Re-read the goal after the await: it may have been cleared, paused,
        // replaced, or had its condition changed while the evaluator ran. Abort
        // the continuation unless it is the SAME goal object we captured at the
        // top of this call. Object identity is the load-bearing check: every
        // user pause/resume/clear/replace goes through patchThread's immutable
        // goal-patch path, which produces a NEW goal object, so identity catches
        // a pause+resume interleaving (resume already sent its own continuation)
        // that field equality would miss -- the resumed goal is active with the
        // same condition, yet a different object. An uninterrupted loop keeps the
        // same reference and proceeds. The field checks are kept for clarity and
        // to short-circuit the cleared/paused cases readably.
        const current = findThread(
          useSessionStore.getState().projects,
          threadId,
        )?.thread.goal;
        if (
          !current ||
          current !== goal ||
          current.status !== "active" ||
          current.condition !== goal.condition
        ) {
          return;
        }
        const outcome = applyEvaluation(current, res);
        if (outcome.type === "met") {
          // The reason recorded/shown on a successful met transition. v1 uses the
          // transcript evaluator's reason; the auditor gate below overrides it
          // with the auditor's reason when that gate is what confirmed the goal.
          let metReason = outcome.reason;
          // HOY-298 verify gate: the transcript evaluator said met. If the goal
          // pins a deterministic verify command, it must ALSO exit 0 before we
          // declare the goal met; otherwise we fall through to continue and carry
          // the command output forward. No verifyCommand => v1 behavior exactly.
          if (current.verifyCommand) {
            let verify: GoalVerifyResult;
            try {
              verify = await verifyGoalCommand(
                sessionId,
                current.verifyCommand,
                current.verifyCwd,
              );
            } catch (e) {
              // Same fail-open discipline as evaluateGoal, but here fail-open
              // means "gate FAILED -> keep working", never a false met: a rejected
              // IPC (no live sidecar, spawn failure) is a code:-1 failure, never a
              // pass, and never an unhandled throw escaping the handler.
              verify = {
                code: -1,
                stdout: "",
                stderr: `verify command could not run: ${String(e)}`,
                killed: false,
              };
            }
            // CRITICAL second re-read (HOY-298): verifyGoalCommand is a SECOND
            // await of up to 120s AFTER the evaluateGoal re-read. The goal may
            // have been cleared/paused/replaced during the command run, so re-read
            // and re-apply the exact object-identity guard against `current` (the
            // object captured before this await). A since-changed goal aborts the
            // transition cleanly: no met, no continuation.
            const c2 = findThread(
              useSessionStore.getState().projects,
              threadId,
            )?.thread.goal;
            if (
              !c2 ||
              c2 !== current ||
              c2.status !== "active" ||
              c2.condition !== current.condition
            ) {
              return;
            }
            if (verify.code !== 0) {
              // Gate failed: treat as continue. Record the failing exit code (for
              // the card) and feed the command output forward as the reason.
              const reason = buildVerifyFailReason(current.verifyCommand, verify);
              patchGoal(threadId, {
                lastReason: reason,
                lastVerifyExit: verify.code,
                turns: action.turns,
                tokensUsed: action.tokensUsed,
              });
              await sendGoalContinuation(threadId, c2.condition, reason);
              return;
            }
            // Gate passed (exit 0): record it, then fall through to the v1 met
            // transition below.
            patchGoal(threadId, { lastVerifyExit: 0 });
          }
          // HOY-299 auditor gate: composes AFTER the (cheaper, deterministic) v2
          // command gate so that gate short-circuits first; if it already forced a
          // continue, the auditor never runs. Only when the goal selected the
          // read-only auditor. The transcript evaluator already said met and the
          // command gate (if any) already passed; now an independent read-only
          // subagent inspects the ACTUAL repo files and must ALSO return met:true
          // before we declare the goal met. undefined/"transcript" => skip
          // entirely (pure v1/v2 behavior; auditGoal is never called).
          if (current.evaluatorKind === "auditor") {
            // Baseline for the third identity guard, captured SYNCHRONOUSLY right
            // before the audit await. It is `current` when no command gate ran,
            // but the verify-pass path above called patchGoal({lastVerifyExit:0}),
            // which replaced the goal object; that patch is synchronous (no user
            // action can interleave before this line), so re-reading here yields
            // the same LOGICAL goal, just its current object identity. Comparing
            // the post-audit re-read against THIS baseline is what detects a user
            // pause/clear/replace during the (long) audit run.
            const preAudit = findThread(
              useSessionStore.getState().projects,
              threadId,
            )?.thread.goal;
            let audit: GoalAudit;
            try {
              audit = await auditGoal(
                sessionId,
                current.condition,
                current.verifyCwd,
              );
            } catch (e) {
              // Same fail-open discipline as the evaluator/verify seams: a rejected
              // IPC (no live sidecar, spawn failure, unparseable stdout) is a
              // FAILED audit -> keep working, never a false met, never an
              // unhandled throw escaping this void-launched handler.
              audit = {
                met: false,
                reason: `auditor could not run: ${String(e)}`,
              };
            }
            // CRITICAL third re-read (HOY-299): auditGoal is a THIRD long await (up
            // to ~180s) AFTER the evaluateGoal and verifyGoalCommand re-reads. The
            // goal may have been cleared/paused/replaced during the audit run, so
            // re-read and re-apply the exact object-identity guard against
            // `preAudit` (the object captured just before this await). A
            // since-changed goal aborts the transition cleanly: no met, no
            // continuation. This is the v1 finding-#1 bug class; do not reintroduce
            // it across this third await.
            const c3 = findThread(
              useSessionStore.getState().projects,
              threadId,
            )?.thread.goal;
            if (
              !c3 ||
              !preAudit ||
              c3 !== preAudit ||
              c3.status !== "active" ||
              c3.condition !== current.condition
            ) {
              return;
            }
            if (!audit.met) {
              // Audit failed: treat as continue. Carry the audit reason forward as
              // both the recorded lastReason and the continuation reason.
              patchGoal(threadId, {
                lastReason: audit.reason,
                turns: action.turns,
                tokensUsed: action.tokensUsed,
              });
              await sendGoalContinuation(threadId, c3.condition, audit.reason);
              return;
            }
            // Audit passed: record its reason as the met reason, then fall through
            // to the met transition below.
            metReason = audit.reason;
          }
          // Bump turns onto the met transition too (Fix 3): a goal met on its
          // Nth turn should read `turn N/cap`, not `N-1/cap`. Same action.turns
          // the continue arm below persists; met termination is unchanged.
          patchGoal(threadId, {
            status: "met",
            turns: action.turns,
            lastReason: metReason,
          });
          pushNotice(threadId, `Goal met: ${metReason}`, "info");
          return;
        }
        // continue: record this turn's progress on the goal (reason, turn
        // count, token delta from the reducer), then re-drive the work.
        patchGoal(threadId, {
          lastReason: outcome.reason,
          turns: action.turns,
          tokensUsed: action.tokensUsed,
        });
        await sendGoalContinuation(threadId, current.condition, outcome.reason);
        return;
      }
    }
  } finally {
    continuationPending.delete(threadId);
  }
}

// HOY-213: after a plan-mode turn finishes, surface the "Plan ready" handoff card
// when the final assistant turn carried a proposed_plan block (inline plan mode
// or a delivered Plan-subagent result, both of which land as assistant text on
// this thread). Detection only reads state; the card drives the actual handoff.
function flagPlanReadyIfPresent(threadId: string): void {
  const s = useSessionStore.getState();
  const thread = findThread(s.projects, threadId)?.thread;
  if (!thread || thread.permissionMode !== "plan") return;
  const turns = s.turns[threadId];
  if (!turns) return;
  // Scan newest-first rather than only the last turn: a plan-mode turn that
  // spawns explore subagents writes its proposed_plan block before those
  // subagents finish, and each delivered result appends a trailing
  // user+assistant turn (HOY-233). The plan is therefore usually NOT the last
  // turn, so we check every assistant turn and take the most recent one that
  // carries a complete proposed_plan block. Only the last-turn check here meant
  // subagent-assisted plans never raised the handoff card.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const text = turn.blocks
      .map((b) => (b.kind === "text" ? b.content : ""))
      .join("");
    const plan = extractProposedPlan(text);
    if (plan) {
      useSessionStore.setState((st) => ({
        planReady: { ...st.planReady, [threadId]: plan },
      }));
      return;
    }
  }
}

// HOY-300: a finished child answers its parent's blocked agent-tool request with
// its result (in-band), replacing HOY-233's turn-injection delivery. The parent's
// ctx.ui.input resolves to this value and its turn continues with the result in
// context. The child stays a watchable thread; its panel auto-closes.
export function respondSubagentResult(childThreadId: string): void {
  const req = takeSubagentRequest(childThreadId);
  if (!req) return; // not a sync child (or already answered)
  const state = useSessionStore.getState();
  const childTurns = state.turns[childThreadId] ?? [];
  const value = frameSubagentResult(
    findThread(state.projects, childThreadId)?.thread.spawnedBy?.type ?? "subagent",
    extractResultText(childTurns),
  );
  void ipcRespondPermission(req.parentSessionId, req.requestId, { value });
  // Stamp terminal + auto-close the child panel (parity with the old flow).
  useSessionStore.setState((s) => ({
    projects: patchThread(s.projects, childThreadId, (th) => ({
      ...th,
      completedAt: th.completedAt ?? Date.now(),
    })),
  }));
  useSessionStore.getState().closePanel(childThreadId);
}

// Monotonic id for transient extension `notify` notices, so each can be
// dismissed (by click or auto-expiry) without colliding.
let noticeSeq = 0;
const NOTICE_TTL_MS = 6000;

// Push a transient, auto-expiring notice onto a thread (HOY-229 compaction
// results reuse the same mechanism as extension `notify`).
function pushNotice(threadId: string, message: string, type: NotifyType) {
  const id = ++noticeSeq;
  const { notices } = useSessionStore.getState();
  useSessionStore.setState({
    notices: {
      ...notices,
      [threadId]: [...(notices[threadId] ?? []), { id, message, type }],
    },
  });
  setTimeout(
    () => useSessionStore.getState().dismissNotice(threadId, id),
    NOTICE_TTL_MS,
  );
}

function acquireSession(
  threadId: string,
  cwd: string,
  sessionFile: string | null | undefined,
): Promise<string> {
  const existing = pendingSessions.get(threadId);
  if (existing) return existing;
  // threadId already carries the thread's own parentThreadId chain (this
  // reopens an existing thread's sidecar, root or subagent), so its depth is
  // computed directly rather than derived from a parent + 1.
  const depth = threadDepth(useSessionStore.getState().projects, threadId);
  const spawn = createSession(
    cwd,
    sessionFile ?? null,
    null,
    null,
    depth,
    usePrefsStore.getState().requireSubagentApproval,
    // Reopen path: the thread opens its own transcript (sessionFile), so there is
    // no parent to fork from (HOY-244).
    null,
  ).finally(() => pendingSessions.delete(threadId));
  pendingSessions.set(threadId, spawn);
  return spawn;
}

// Idempotence: submitPrompt and hydrateThread both call this after the deduped
// acquireSession resolves; the Set is marked synchronously so a concurrent
// second call returns while the first is still in flight, and unmarked on
// failure so the next prompt retries the reconcile (a poisoned guard would
// silently send prompts on whatever model the session has). Pruned on session
// close via releaseSession.
const modelApplied = new Set<string>();

// Tear down a live sidecar and the per-session guard entries that go with it.
function releaseSession(sessionId: string): void {
  modelApplied.delete(sessionId);
  permissionModeApplied.delete(sessionId);
  autoCompactionApplied.delete(sessionId);
  void closeSession(sessionId);
}

// Sessions whose sidecar already carries the thread's permission mode, so
// repeat prompts skip the redundant /hoy_mode round trip. Same lifecycle as
// modelApplied above.
const permissionModeApplied = new Set<string>();

// Apply a thread's recorded permission mode to a freshly available session
// (HOY-186). A default-mode thread needs nothing: the extension starts there.
async function applyThreadPermissionMode(
  threadId: string,
  sessionId: string,
): Promise<void> {
  if (permissionModeApplied.has(sessionId)) return;
  permissionModeApplied.add(sessionId);
  const mode =
    findThread(useSessionStore.getState().projects, threadId)?.thread
      .permissionMode ?? "default";
  if (mode === "default") return;
  try {
    await ipcSetPermissionMode(sessionId, mode);
  } catch (e) {
    permissionModeApplied.delete(sessionId);
    throw e;
  }
}

// Sessions already told the global auto-compaction default, so repeat prompts
// to a live session skip the redundant set_auto_compaction. Same lifecycle as
// modelApplied / permissionModeApplied above.
const autoCompactionApplied = new Set<string>();

// Apply the user's global auto-compaction default (HOY-275) to a freshly
// available session. Pi persists compaction globally and defaults it on, but
// that persisted value is unreachable when the toggle is set from Settings with
// no session open, so the renderer pref is authoritative and pushed to every
// session on spawn. Best-effort: a settings RPC hiccup must never block a
// prompt, so it swallows its own error (and clears the guard to retry) rather
// than throwing into the caller.
async function applyAutoCompaction(sessionId: string): Promise<void> {
  if (autoCompactionApplied.has(sessionId)) return;
  autoCompactionApplied.add(sessionId);
  try {
    await ipcSetAutoCompaction(sessionId, usePrefsStore.getState().autoCompaction);
  } catch {
    // Non-fatal; retry on the next spawn. Pi's persisted global still applies.
    autoCompactionApplied.delete(sessionId);
  }
}

// Entry ids aligned to a session's getMessages output (HOY-304), for
// entry-addressable transcript restore. Fetches the tree entries and derives the
// leaf chain's message ids; returns them ONLY when they align 1:1 with the
// message count, so a divergence (or a get_entries failure) degrades to an
// unaddressed transcript rather than mis-mapping tree clicks to wrong turns.
async function entryIdsFor(
  sessionId: string,
  messageCount: number,
): Promise<(string | undefined)[] | undefined> {
  try {
    const { entries, leafId } = await getEntries(sessionId);
    const ids = leafChainMessageIds(entries, leafId);
    return ids.length === messageCount ? ids : undefined;
  } catch {
    return undefined;
  }
}

// The shared fork/clone flow (HOY-283 branch, HOY-284 clone). Opens a FRESH
// sidecar on the source thread's file, runs `op` to rebind it to a new branch
// file (source untouched), then surfaces that file as a child thread. `op`
// returns the composer prefill (fork's forked user message) or nothing (clone);
// a cancelled result tears the sidecar down and adds no thread. `copy` carries the
// fork-vs-clone wording so the one flow serves both.
async function branchIntoChildThread(
  threadId: string,
  op: (branchSessionId: string) => Promise<{ cancelled: boolean; text?: string }>,
  copy: { busy: string; fail: string; titlePrefix: string; done: (title: string) => string },
): Promise<void> {
  const store = useSessionStore;
  const found = findThread(store.getState().projects, threadId);
  if (!found) return;
  const { project, thread: source } = found;
  if (!source.sessionFile) {
    pushNotice(threadId, "Can't branch yet: this thread has no saved session.", "error");
    return;
  }
  // The op reads the source file; branching mid-write risks a torn read, so wait
  // for a settled point (the spike's double-open note).
  if (store.getState().streaming[threadId]) {
    pushNotice(threadId, copy.busy, "info");
    return;
  }

  const cwd = project.path ?? "";
  const depth = threadDepth(store.getState().projects, threadId);
  // Open a fresh sidecar on the SOURCE file, then fork/clone it: pi writes a new
  // branch file and rebinds THIS sidecar to it, leaving the source untouched.
  let branchSessionId: string;
  try {
    branchSessionId = await createSession(
      cwd,
      source.sessionFile,
      null,
      source.permissionMode ?? null,
      depth,
      usePrefsStore.getState().requireSubagentApproval,
      null,
    );
  } catch (e) {
    pushNotice(threadId, `${copy.fail} failed: ${String(e)}`, "error");
    return;
  }

  let forkText: string | undefined;
  try {
    const result = await op(branchSessionId);
    if (result.cancelled) {
      releaseSession(branchSessionId);
      pushNotice(threadId, `${copy.fail} cancelled.`, "info");
      return;
    }
    forkText = result.text;
  } catch (e) {
    releaseSession(branchSessionId);
    pushNotice(threadId, `${copy.fail} failed: ${String(e)}`, "error");
    return;
  }

  // The sidecar now points at the branch; read its new file and transcript.
  let branchFile: string | undefined;
  try {
    branchFile = (await getSessionStats(branchSessionId)).sessionFile ?? undefined;
  } catch {
    // Best-effort: without the file the thread still works live; a reopen after
    // restart just can't restore it. Surfaced by the missing sessionFile.
  }
  let branchTurns: Turn[] = [];
  try {
    const branchMessages = await getMessages(branchSessionId);
    branchTurns = messagesToTurns(
      branchMessages,
      await entryIdsFor(branchSessionId, branchMessages.length),
    );
  } catch {
    // Best-effort: a failed read leaves an empty transcript, repopulated live.
  }

  const childId = shortId("t");
  const seed = (forkText?.trim() || source.title).trim();
  const child: Thread = {
    id: childId,
    title: `${copy.titlePrefix}: ${seed.length > 40 ? `${seed.slice(0, 40)}...` : seed}`,
    updatedAt: Date.now(),
    sessionId: branchSessionId,
    sessionFile: branchFile,
    parentThreadId: threadId,
    ...(source.model ? { model: source.model } : {}),
    ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
    ...(source.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
  };
  store.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === project.id ? { ...p, threads: [...p.threads, child] } : p,
    ),
    turns: { ...s.turns, [childId]: branchTurns },
  }));
  // Open the branch (its sessionId is already live, so hydrateThread no-ops), and
  // prefill the composer with the forked user message (pi's behavior; clone has none).
  store.getState().openThread(childId);
  if (forkText) store.getState().setDraft(childId, forkText);
  pushNotice(childId, copy.done(source.title), "info");
}

// Resolve a subagent def's fuzzy `model` string (a free-text name in the
// registry file, not a validated ModelRef) against the loaded model list
// (HOY-234). Exact id match first, else a case-insensitive substring match on
// id or name; null when nothing matches, so the caller falls back to the
// parent thread's model rather than spawning on a bogus pick.
function resolveModelRef(
  state: SessionStore,
  fuzzy: string,
): ModelRef | null {
  const exact = state.models.find((m) => m.id === fuzzy);
  if (exact) return { provider: exact.provider, id: exact.id };
  const needle = fuzzy.toLowerCase();
  const fuzzyMatch = state.models.find(
    (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
  );
  return fuzzyMatch ? { provider: fuzzyMatch.provider, id: fuzzyMatch.id } : null;
}

// Reconcile the thread's pending model pick with a freshly available session.
// get_state gives the session truth; set_model fires only when the pick differs
// (a redundant call would append a model_change JSONL entry on every reopen).
// With no pick, the thread adopts the session's model (restore hydration).
async function applyThreadModel(
  threadId: string,
  sessionId: string,
): Promise<void> {
  if (modelApplied.has(sessionId)) return;
  modelApplied.add(sessionId);

  const store = useSessionStore;
  const setThreadModel = (model: ModelRef | null) =>
    store.setState((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({ ...th, model })),
    }));

  try {
    const pick =
      findThread(store.getState().projects, threadId)?.thread.model ?? null;
    const piState = await getState(sessionId);
    const truth: ModelRef | null = piState.model
      ? { provider: piState.model.provider, id: piState.model.id }
      : null;

    // Thinking level: reconcile the deferred pick with the session truth, the
    // same shape as the model below (HOY-204). No pick adopts pi's level; a
    // differing pick is sent, reverting to truth if pi rejects it. Unlike the
    // model, a failure here does not abort: the prompt can still go out.
    const thinkPick =
      findThread(store.getState().projects, threadId)?.thread.thinkingLevel ??
      null;
    const setThreadThinking = (level: ThinkingLevel) =>
      store.setState((s) => ({
        projects: patchThread(s.projects, threadId, (th) => ({
          ...th,
          thinkingLevel: level,
        })),
      }));
    if (!thinkPick || thinkPick === piState.thinkingLevel) {
      setThreadThinking(piState.thinkingLevel);
    } else {
      try {
        await setThinkingLevel(sessionId, thinkPick);
        // Pi may clamp the level; re-read to sync the effective value.
        const fresh = await getState(sessionId);
        setThreadThinking(fresh.thinkingLevel);
      } catch (e) {
        setThreadThinking(piState.thinkingLevel);
        store.setState((s) => ({
          threadErrors: { ...s.threadErrors, [threadId]: String(e) },
        }));
      }
    }

    if (!pick) {
      if (truth) setThreadModel(truth);
      return;
    }
    if (truth && truth.provider === pick.provider && truth.id === pick.id)
      return;

    try {
      await setModel(sessionId, pick.provider, pick.id);
      // Pi persisted the pick as the global defaultModel; mirror it.
      store.setState({ defaultModel: pick });
    } catch (e) {
      // Revert to the session truth so the selector snaps back; a re-pick on
      // the now-live session goes through selectModel directly.
      setThreadModel(truth);
      throw e;
    }
  } catch (e) {
    modelApplied.delete(sessionId);
    throw e;
  }
}

// Autosave: persist the projects tree (debounced) whenever it changes, but only
// after initWorkspace has loaded the existing file, so the initial empty state
// never clobbers saved work. The live sessionId is ephemeral and not persisted.
let hydrated = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Last serialized payload: skips redundant writes when a projects-ref change
// (e.g. pinning the ephemeral sessionId) leaves the persisted shape unchanged.
let lastSaved = "";

function persistProjects(
  projects: Project[],
  turns: Record<string, Turn[]>,
  drafts: Record<string, string>,
  activeProjectId: string | null,
): void {
  const payload = {
    activeProjectId: activeProjectId ?? null,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path ?? null,
      // Untouched threads never reach disk: they vanish on restart even if
      // their panel was left open, and legacy empty rows in an existing
      // workspace.json drop off on the next save.
      threads: p.threads
        .filter((t) => !isUntouched(t, turns, drafts))
        .map((t) => ({
          id: t.id,
          title: t.title,
          updatedAt: t.updatedAt,
          sessionFile: t.sessionFile ?? null,
          archived: !!t.archived,
          renamed: !!t.renamed,
          draft: drafts[t.id] || null,
          permissionMode: t.permissionMode ?? null,
          parentThreadId: t.parentThreadId ?? null,
          spawnedBy: t.spawnedBy ?? null,
          // Cached so the sidebar shows the thread's model glyph on load without
          // spawning the session; reconciled against get_state on open (HOY-267).
          model: t.model ?? null,
          // Goal Mode (HOY-263): persisted as-is (omitted entirely, rather than
          // null, when absent -- the brief's `goal?: ThreadGoal` has no null
          // arm). loadWorkspace resets counters and demotes "active" to
          // "paused" on the way back in, so a running loop never auto-resumes
          // just from reopening the app.
          goal: t.goal,
        })),
    })),
  };
  const json = JSON.stringify(payload);
  if (json === lastSaved) return;
  // Record the saved content only after the write succeeds, so a transient
  // failure doesn't make an identical next state skip the (still-needed) retry.
  void saveWorkspace(payload).then(
    () => {
      lastSaved = json;
    },
    () => {},
  );
}

useSessionStore.subscribe((state, prev) => {
  if (
    state.projects === prev.projects &&
    state.drafts === prev.drafts &&
    state.activeProjectId === prev.activeProjectId
  )
    return;
  if (!hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Read at fire time: the debounce window may batch several changes, and
    // the untouched filter needs the turns that exist when the write happens.
    const s = useSessionStore.getState();
    persistProjects(s.projects, s.turns, s.drafts, s.activeProjectId);
  }, 300);
});

// A thread the user never invested in: no prompt ever sent (no transcript on
// disk or in memory), never renamed, and no unsent draft. Untouched threads
// are never persisted and are discarded when their panel closes or they are
// archived.
function isUntouched(
  thread: Thread,
  turns: Record<string, Turn[]>,
  drafts: Record<string, string>,
): boolean {
  return (
    !thread.sessionFile &&
    !turns[thread.id]?.length &&
    !thread.renamed &&
    !drafts[thread.id]?.trim()
  );
}

// Dispatch one of the three teardown actions; shared by requestTeardown's
// immediate path and confirmTeardown.
function runTeardown(
  s: SessionStore,
  action: "close" | "archive" | "delete",
  threadId: string,
): void {
  if (action === "close") s.closePanel(threadId);
  else if (action === "archive") s.archiveThread(threadId);
  else s.deleteThread(threadId);
}

// Locate a thread and its owning project by id. Threads live nested under
// projects; the one traversal shared by store actions and components.
export function findThread(
  projects: Project[],
  threadId: string,
): { thread: Thread; project: Project } | null {
  for (const project of projects) {
    const thread = project.threads.find((t) => t.id === threadId);
    if (thread) return { thread, project };
  }
  return null;
}

// Return a new projects list with `patch` applied to the matching thread.
function patchThread(
  projects: Project[],
  threadId: string,
  patch: (thread: Thread) => Thread,
): Project[] {
  return projects.map((p) => ({
    ...p,
    threads: p.threads.map((t) => (t.id === threadId ? patch(t) : t)),
  }));
}

// Goal Mode (HOY-263) load semantics: a persisted goal must never auto-run
// just because the app reopened. "met"/"cleared" goals are done, so they are
// dropped rather than restored. An "active" goal is demoted to "paused" and
// its per-run counters reset -- turns and startedAt start over, and the
// baseline absorbs whatever was already used so the next evaluate() call (once
// the user explicitly resumes and a sidecar is live again) measures a fresh
// delta instead of replaying stale usage against a since-restarted session.
// "paused" and "capped" goals already do not auto-run, so they pass through
// unchanged.
function restoreGoal(goal: ThreadGoal | undefined): ThreadGoal | undefined {
  if (!goal) return undefined;
  if (goal.status === "met" || goal.status === "cleared") return undefined;
  if (goal.status !== "active") return goal;
  return {
    ...goal,
    status: "paused",
    turns: 0,
    startedAt: Date.now(),
    tokensBaseline: goal.tokensBaseline + goal.tokensUsed,
    tokensUsed: 0,
  };
}


function truncateTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
