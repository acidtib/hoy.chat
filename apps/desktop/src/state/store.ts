import { create } from "zustand";
import {
  abort,
  Channel,
  closeSession,
  compact as ipcCompact,
  setAutoCompaction as ipcSetAutoCompaction,
  createSession,
  deleteSessionFile,
  enqueuePrompt,
  getCommands,
  getMessages,
  getSessionStats,
  getState,
  listProjectPaths,
  listSubagents,
  loadWorkspace,
  readContextFile,
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
} from "@/lib/ipc";
import { applyEvent, markToolPending, messagesToTurns } from "@/lib/turns";
import { fileToImageAttachment } from "@/lib/images";
import { draftContexts, draftToMessage } from "@/lib/mentions";
import { usePrefsStore } from "@/state/prefs";
import {
  buildDelivery,
  childThreadIdsOf,
  queueDelivery,
  shouldDeferUpDelivery,
  shouldDeliverToParent,
  takeNextDelivery,
  threadDepth,
  type Delivery,
} from "./delivery";
import { MAX_SUBAGENT_DEPTH, MAX_CONCURRENT_AGENTS } from "./limits";
import type {
  AgentEvent,
  ContextRef,
  ExtWidget,
  ImageAttachment,
  ImageContent,
  McpScope,
  ModelInfo,
  ModelRef,
  Notice,
  NotifyType,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderAuth,
  ProviderInfo,
  SessionStats,
  SlashCommand,
  StreamingBehavior,
  SubagentDef,
  ThinkingLevel,
  Thread,
  Turn,
} from "@/lib/types";
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

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Math.floor(Math.random() * 1e9).toString(36)}`;
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
type SpawnPayload = { agentId: string; subagentType: string; task: string };

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
  sidebarWidth: number;
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
  threadErrors: Record<string, string | null>;
  // Manual compaction in flight, keyed by threadId; gates the Compact affordance
  // and shows a compacting chip (HOY-229).
  compacting: Record<string, boolean>;
  // Per-session auto-compaction, mirrored from get_state and written via
  // set_auto_compaction; read by the MemoryPanel toggle (HOY-229).
  autoCompaction: Record<string, boolean>;
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
  // Outstanding-children counter, keyed by parent thread id (HOY-245). Transient,
  // never persisted. Incremented when a child is spawned, decremented when a
  // child's result is applied to the parent. An intermediate agent defers its own
  // up-delivery while this is > 0 so its result reflects its descendants' work.
  outstandingChildren: Record<string, number>;
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
  ) => Promise<void>;
  // Abort the thread's streaming turn (HOY-195). The turn's terminal events
  // arrive over the channel as usual; no state is flipped here.
  stopStreaming: (threadId: string) => Promise<void>;
  refreshStats: (threadId: string) => Promise<void>;
  // Pull the session's slash commands into the store (HOY-223). No-op without a
  // live session; a failure degrades quietly to the built-ins.
  refreshSlashCommands: (threadId: string) => Promise<void>;
  // Trigger a manual compaction on the thread's session, optionally with custom
  // summarization instructions (HOY-229). Gated on an idle, live session.
  compact: (threadId: string, customInstructions?: string) => Promise<void>;
  // Toggle per-session auto-compaction and re-sync from get_state (HOY-229).
  setAutoCompaction: (threadId: string, enabled: boolean) => Promise<void>;
  // Pull the session's current autoCompactionEnabled into the store.
  refreshAutoCompaction: (threadId: string) => Promise<void>;
  setThreadSessionIdInternal: (threadId: string, sessionId: string) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  // Empty until initWorkspace() loads the persisted tree from disk on boot.
  projects: [],
  panels: [],
  activeThreadId: null,
  activeProjectId: null,
  bodyWidth: initialBodyWidth(),
  sidebarCollapsed: false,
  sidebarView: "projects",
  settingsOpen: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
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
  threadErrors: {},
  compacting: {},
  autoCompaction: {},
  pendingPermissions: {},
  notices: {},
  statuses: {},
  widgets: {},
  slashCommands: {},
  drafts: {},
  composerAttachments: {},
  runningAgents: new Set<string>(),
  agentQueue: [],
  queuedPayloads: {},
  outstandingChildren: {},
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

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarView: (view) => set({ sidebarView: view }),
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
        id: newId("t"),
        title: "New thread",
        updatedAt: Date.now(),
        sessionId: null,
      };
      openId = thread.id;
      return {
        projects: [...s.projects, { id: newId("p"), name, path, threads: [thread] }],
      };
    });
    if (openId) get().openThread(openId);
  },
  addThread: (projectId) => {
    const thread: Thread = {
      id: newId("t"),
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
    const childId = newId("t");
    const def = get().subagents.find((d) => d.name === payload.subagentType);
    // A type with no model inherits the parent's (closes HOY-237); thinking
    // likewise. A type with a model that fails to resolve also falls back to
    // the parent's rather than spawning on an arbitrary default.
    const childModel = def?.model
      ? (resolveModelRef(get(), def.model) ?? parent.model ?? null)
      : (parent.model ?? null);
    const childThinking =
      (def?.thinking as ThinkingLevel | undefined) ?? parent.thinkingLevel ?? null;
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
      // HOY-245: count this child against its parent so the parent defers its own
      // up-delivery until the child (run-now or queued) delivers back into it.
      outstandingChildren: {
        ...s.outstandingChildren,
        [parentThreadId]: (s.outstandingChildren[parentThreadId] ?? 0) + 1,
      },
    }));
    // Auto-open the child so the user follows the run live instead of finding
    // it after the fact (HOY-236). The child is already in projects above, so
    // openThread's findThread resolves. FleetView (HOY-235) will later route
    // this to a consolidated view; the call site is unchanged. HOY-246 will gate
    // this so a queued child does not steal focus; left as-is for now.
    get().openThread(childId);
    // Concurrency gate (HOY-245): an initial run takes a slot only if one is
    // free; otherwise the child waits FIFO. A slot releases on the run's first
    // done. Foreground and resume runs bypass this entirely (they never reach
    // here), which is what keeps deep trees deadlock-free under a small cap.
    if (get().runningAgents.size < MAX_CONCURRENT_AGENTS) {
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
    if (!s.agentQueue.length || s.runningAgents.size >= MAX_CONCURRENT_AGENTS) {
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
  submitPrompt: async (threadId, message, images, behavior) => {
    const found = findThread(get().projects, threadId);
    if (!found) return;
    const { thread, project } = found;

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

    const hasImages = !!images && images.length > 0;
    if (!text && !hasImages && contexts.length === 0) return;

    // The composer's attachments are consumed by this send; clear them (and
    // revoke their previews) so they cannot be sent twice (HOY-205).
    get().clearAttachments(threadId);
    const contextBlock = await buildContextBlock(contexts, project.path ?? "");
    const outbound = contextBlock ? `${contextBlock}\n\n${text}` : text;

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

  setAutoCompaction: async (threadId, enabled) => {
    const thread = findThread(get().projects, threadId)?.thread;
    if (!thread?.sessionId) return;
    const previous = get().autoCompaction[threadId];
    set((s) => ({ autoCompaction: { ...s.autoCompaction, [threadId]: enabled } }));
    try {
      await ipcSetAutoCompaction(thread.sessionId, enabled);
      // Re-sync in case Pi's effective state differs from the requested value.
      const synced = await getState(thread.sessionId).catch(() => null);
      if (synced) {
        set((s) => ({
          autoCompaction: {
            ...s.autoCompaction,
            [threadId]: synced.autoCompactionEnabled,
          },
        }));
      }
    } catch (e) {
      set((s) => ({
        autoCompaction: { ...s.autoCompaction, [threadId]: previous ?? !enabled },
        threadErrors: { ...s.threadErrors, [threadId]: String(e) },
      }));
    }
  },

  refreshAutoCompaction: async (threadId) => {
    const sessionId = findThread(get().projects, threadId)?.thread.sessionId;
    if (!sessionId) return;
    const synced = await getState(sessionId).catch(() => null);
    if (synced) {
      set((s) => ({
        autoCompaction: {
          ...s.autoCompaction,
          [threadId]: synced.autoCompactionEnabled,
        },
      }));
    }
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
          const { draft, ...rest } = t;
          if (draft) drafts[rest.id] = draft;
          return !rest.renamed && !rest.sessionFile && rest.title !== "New thread"
            ? { ...rest, renamed: true }
            : rest;
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

  // Restore a reopened thread's transcript: spawn a sidecar that opens its
  // session file, pull the messages, and fold them into turns. No-op for a
  // brand-new thread (no sessionFile -> spawns lazily on first prompt) or one
  // already live/loaded.
  hydrateThread: async (threadId) => {
    const found = findThread(get().projects, threadId);
    if (!found) return;
    const { thread, project } = found;
    if (!thread.sessionFile || thread.sessionId) return;
    if ((get().turns[threadId]?.length ?? 0) > 0) return;
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
      // A concurrent submitPrompt may have populated turns and sent a prompt
      // while we were spawning; don't clobber it with the restored transcript.
      if ((get().turns[threadId]?.length ?? 0) > 0) return;
      const messages = await getMessages(sessionId);
      if ((get().turns[threadId]?.length ?? 0) > 0) return;
      set((s) => ({
        turns: { ...s.turns, [threadId]: messagesToTurns(messages) },
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

// Dedup concurrent session spawns for one thread: openThread fires hydrateThread
// while the user may submitPrompt before it resolves. Sharing the in-flight
// promise means both get the same sidecar instead of spawning (and leaking) two.
const pendingSessions = new Map<string, Promise<string>>();

// The channel currently streaming a turn for each thread. Used to ignore trailing
// events from a channel whose thread has moved on (panel closed, or a newer turn
// started). Entry is dropped on done / close / send failure.
const activeChannels = new Map<string, Channel<AgentEvent>>();

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
    const sessionId = await createSession(
      cwd,
      null,
      payload.subagentType,
      parent?.permissionMode ?? null,
      childDepth,
    );
    useSessionStore.setState((s) => ({
      projects: patchThread(s.projects, childId, (t) => ({ ...t, sessionId })),
    }));
    // Same reconcile as submitPrompt: apply the (possibly inherited) model and
    // permission mode before the prompt streams.
    await applyThreadModel(childId, sessionId);
    await applyThreadPermissionMode(childId, sessionId);
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
    if (
      !s.runningAgents.has(threadId) &&
      !s.agentQueue.includes(threadId) &&
      !(threadId in s.queuedPayloads)
    ) {
      return {};
    }
    const runningAgents = new Set(s.runningAgents);
    runningAgents.delete(threadId);
    const { [threadId]: _dropped, ...queuedPayloads } = s.queuedPayloads;
    return {
      runningAgents,
      agentQueue: s.agentQueue.filter((id) => id !== threadId),
      queuedPayloads,
    };
  });
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
    // A subagent spawn (HOY-231): create the child thread and drive it
    // through this same helper, rather than folding it into this thread's
    // transcript.
    if (event.kind === "subagentSpawned") {
      void useSessionStore.getState().spawnChildThread(threadId, {
        agentId: event.agentId,
        subagentType: event.subagentType,
        task: event.task,
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
      // HOY-233: push this child's result up to its parent, and drain any
      // deliveries queued for this thread while it streamed.
      void deliverAndDrain(threadId);
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
    }
  };

  await sendPrompt(sessionId, message, channel, images);
}

// HOY-233: on a thread's `done`, push a finished child's result up to its parent
// and drain any deliveries that queued for this thread while it was streaming.
async function deliverAndDrain(finishedThreadId: string): Promise<void> {
  const state = useSessionStore.getState();
  const found = findThread(state.projects, finishedThreadId);
  if (!found) return;
  const { thread } = found;
  // HOY-245: an intermediate agent (a subagent that is itself a parent) must not
  // deliver its result up while it still has outstanding children; its result
  // would be computed before their work lands. Defer until the counter is 0.
  // Depth-1 leaves have no children (counter undefined -> 0), so they deliver
  // immediately, exactly as before.
  const outstanding = state.outstandingChildren[finishedThreadId] ?? 0;
  const deferUp = shouldDeferUpDelivery(thread, outstanding);
  if (!deferUp && shouldDeliverToParent(thread)) {
    const childTurns = state.turns[finishedThreadId] ?? [];
    const delivery = buildDelivery(
      thread.spawnedBy?.type ?? "subagent",
      thread.spawnedBy?.agentId ?? "",
      childTurns,
    );
    await deliverToParent(thread.parentThreadId!, delivery);
    // Stamp terminal so a later done (follow-up) does not re-deliver. HOY-239.
    useSessionStore.setState((s) => ({
      projects: patchThread(s.projects, finishedThreadId, (th) => ({
        ...th,
        completedAt: th.completedAt ?? Date.now(),
      })),
    }));
    // Auto-close: a delivered child is terminal. closePanel kills its sidecar
    // and drops the panel; the sessionFile persists so reopening rehydrates
    // read-only. Reopen-to-continue is harmless (completedAt guard = no
    // re-deliver). Runs AFTER deliverToParent, which read the child's turns.
    useSessionStore.getState().closePanel(finishedThreadId);
  }
  // This thread may itself be a parent with a queued delivery: it just went idle,
  // so deliver the next one now (deliverToParent handles the not-busy path).
  const next = takeNextDelivery(finishedThreadId);
  if (next) await deliverToParent(finishedThreadId, next);
}

// Parents with a delivery in flight but whose activeChannels slot is not yet
// set (the acquireSession await window when the panel was closed). Guards the
// check-then-act race so two children finishing back-to-back cannot both resume
// a session-less parent and clobber each other's turn.
const deliveringParents = new Set<string>();

// Inject `delivery` into `parentThreadId` as a marked subagent-result turn and
// stream the parent's continuation. If the parent is mid-turn, queue instead and
// let its next `done` drain it. Resumes the parent sidecar from its transcript
// when the panel was closed.
async function deliverToParent(parentThreadId: string, delivery: Delivery): Promise<void> {
  if (activeChannels.has(parentThreadId) || deliveringParents.has(parentThreadId)) {
    queueDelivery(parentThreadId, delivery);
    return;
  }
  const found = findThread(useSessionStore.getState().projects, parentThreadId);
  if (!found) return;
  const { project, thread: parent } = found;
  // Claim the slot synchronously, before any await, so a concurrent child's
  // done handler queues instead of racing the acquireSession window. Handed off
  // to activeChannels (set synchronously inside streamPromptOnThread) for the
  // rest of the turn; released in finally.
  deliveringParents.add(parentThreadId);
  let seeded = false;
  try {
    let sessionId = parent.sessionId ?? null;
    if (!sessionId) {
      if (!parent.sessionFile) return; // unreachable: a parent has run a turn
      sessionId = await acquireSession(parentThreadId, project.path ?? "", parent.sessionFile);
      useSessionStore.getState().setThreadSessionIdInternal(parentThreadId, sessionId);
    }
    useSessionStore.setState((s) => ({
      turns: {
        ...s.turns,
        [parentThreadId]: [
          ...(s.turns[parentThreadId] ?? []),
          {
            role: "user" as const,
            text: delivery.message,
            origin: "subagentResult" as const,
            subagent: { type: delivery.subagentType, agentId: delivery.agentId },
          },
          { role: "assistant" as const, blocks: [], streaming: true },
        ],
      },
      streaming: { ...s.streaming, [parentThreadId]: true },
      threadErrors: { ...s.threadErrors, [parentThreadId]: null },
      projects: patchThread(s.projects, parentThreadId, (th) => ({
        ...th,
        updatedAt: Date.now(),
      })),
      // HOY-245: this is the single point a child's result is APPLIED to the
      // parent (the busy/queued early-return above does not reach here). One
      // decrement per apply; when it hits 0 the parent stops deferring and its
      // next done delivers its now-complete result up.
      outstandingChildren: (() => {
        const cur = s.outstandingChildren[parentThreadId] ?? 0;
        const nextCount = Math.max(0, cur - 1);
        const copy = { ...s.outstandingChildren };
        if (nextCount === 0) delete copy[parentThreadId];
        else copy[parentThreadId] = nextCount;
        return copy;
      })(),
    }));
    seeded = true;
    await streamPromptOnThread(parentThreadId, sessionId, delivery.message);
  } catch (e) {
    // Mirror submitPrompt's catch: drop the channel so a failed delivery does
    // not block every future one behind a stale busy-guard. Only rewrite the
    // trailing turn when this call actually seeded the assistant shell; if
    // acquireSession threw before seeding, the last turn is the parent's prior
    // completed turn, so fall to the thread banner instead of corrupting it.
    activeChannels.delete(parentThreadId);
    useSessionStore.setState((s) => {
      const list = s.turns[parentThreadId] ?? [];
      const last = list[list.length - 1];
      const streaming = { ...s.streaming, [parentThreadId]: false };
      if (seeded && last && last.role === "assistant") {
        return {
          streaming,
          turns: {
            ...s.turns,
            [parentThreadId]: [...list.slice(0, -1), { ...last, streaming: false, error: String(e) }],
          },
        };
      }
      return { streaming, threadErrors: { ...s.threadErrors, [parentThreadId]: String(e) } };
    });
  } finally {
    deliveringParents.delete(parentThreadId);
  }
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
  const spawn = createSession(cwd, sessionFile ?? null, null, null, depth).finally(() =>
    pendingSessions.delete(threadId),
  );
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

function truncateTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
