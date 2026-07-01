import { create } from "zustand";
import {
  abort,
  Channel,
  closeSession,
  createSession,
  deleteSessionFile,
  enqueuePrompt,
  getMessages,
  getSessionStats,
  getState,
  listProjectPaths,
  loadWorkspace,
  readContextFile,
  removeProviderKey as ipcRemoveProviderKey,
  respondPermission as ipcRespondPermission,
  saveProviderKey as ipcSaveProviderKey,
  saveWorkspace,
  sendPrompt,
  setModel,
  setPermissionMode as ipcSetPermissionMode,
  setThinkingLevel,
} from "@/lib/ipc";
import { applyEvent, markToolPending, messagesToTurns } from "@/lib/turns";
import { fileToImageAttachment } from "@/lib/images";
import { draftContexts, draftToMessage } from "@/lib/mentions";
import type {
  AgentEvent,
  ContextRef,
  ExtWidget,
  ImageAttachment,
  ImageContent,
  ModelInfo,
  ModelRef,
  Notice,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderAuth,
  ProviderInfo,
  SessionStats,
  StreamingBehavior,
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

// Session list is keyed by sessionId from the start so multi-session is a data
// change, not a redesign. Models, supported providers, and provider auth status
// are cached here so the top bar and settings page render from our state.
// Projects/threads drive the sidebar; `panels` is the set of threads open in the
// main body and `activeThreadId` is the focused one (null = home page).
interface SessionStore {
  projects: Project[];
  panels: Panel[];
  activeThreadId: string | null;
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
  // Composer drafts keyed by threadId. Store-held so hidden panels and app
  // restarts keep unsent text; persisted via the workspace autosave as each
  // thread's draft field. Never cleared on panel close.
  drafts: Record<string, string>;
  // Pending image attachments for the composer, keyed by threadId (HOY-205).
  // In-memory only (base64 never touches disk); cleared on submit and on panel
  // close, revoking each preview object URL.
  composerAttachments: Record<string, ImageAttachment[]>;
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
  removeProject: (projectId: string) => void;

  // Credential changes go through the store (HOY-196): the backend respawns
  // idle sidecars under their existing sessionIds, so the per-session
  // reconcile guards must be cleared for the next prompt to re-apply each
  // thread's model pick and permission mode.
  saveProviderKey: (provider: string, key: string) => Promise<void>;
  removeProviderKey: (provider: string) => Promise<void>;

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
  setThreadSessionIdInternal: (threadId: string, sessionId: string) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  // Empty until initWorkspace() loads the persisted tree from disk on boot.
  projects: [],
  panels: [],
  activeThreadId: null,
  bodyWidth: initialBodyWidth(),
  sidebarCollapsed: false,
  sidebarView: "projects",
  settingsOpen: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  activeSessionId: null,
  models: [],
  supportedProviders: [],
  providerAuth: [],
  defaultModel: null,
  modelSelecting: {},
  turns: {},
  streaming: {},
  stats: {},
  threadErrors: {},
  pendingPermissions: {},
  notices: {},
  statuses: {},
  widgets: {},
  drafts: {},
  composerAttachments: {},
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
      if (s.panels.some((p) => p.id === id))
        return { activeThreadId: id, expandedThreadId, focusRequest };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return {
        panels: [...panels, { id, width }],
        activeThreadId: id,
        expandedThreadId,
        focusRequest,
      };
    });
    void get().hydrateThread(id);
  },

  // Pointer-down focus inside an open panel: active accent only, no composer
  // focus and no full screen change.
  focusPanel: (id) => set({ activeThreadId: id }),

  requestTeardown: (action, threadId) => {
    if (!get().streaming[threadId]) {
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
      }

      // Apply a deferred pick (or adopt the session's model) before the prompt;
      // a failure throws into the catch below so the prompt never rides on a
      // model the user didn't choose. The guard makes repeat calls free.
      await applyThreadModel(threadId, sessionId);
      // Same for a deferred permission mode (HOY-186): the gate must be in
      // place before the prompt streams.
      await applyThreadPermissionMode(threadId, sessionId);

      const channel = new Channel<AgentEvent>();
      activeChannels.set(threadId, channel);
      channel.onmessage = (event) => {
        // Ignore events from a superseded channel: closing a panel kills the
        // sidecar, which makes the reader emit a (now-expected) error + done over
        // this channel. Without this guard that stale error would resurface as a
        // banner and orphaned turns when the thread is reopened.
        if (activeChannels.get(threadId) !== channel) return;
        set((s) => ({
          turns: {
            ...s.turns,
            [threadId]: applyEvent(s.turns[threadId] ?? [], event),
          },
        }));
        if (event.kind === "permissionRequest") {
          const { kind: _k, ...request } = event;
          set((s) => {
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
          set((s) => {
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
          void get().refreshStats(threadId);
        } else if (event.kind === "queueUpdate") {
          // Pi sends the full queue arrays each time; replace, don't append. The
          // chips reflect what is still queued; anything that left the queue was
          // delivered into the run, so render it as a user turn followed by a
          // fresh assistant turn (HOY-218). This keeps the live transcript in
          // order and identical to a reloaded thread.
          set((s) => {
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
          set((s) => ({
            notices: {
              ...s.notices,
              [threadId]: [
                ...(s.notices[threadId] ?? []),
                { id, message: event.message, type: event.notifyType ?? "info" },
              ],
            },
          }));
          setTimeout(() => get().dismissNotice(threadId, id), NOTICE_TTL_MS);
        } else if (event.kind === "setStatus") {
          // Keyed footer status; an absent statusText clears that key.
          set((s) => {
            const thread = { ...(s.statuses[threadId] ?? {}) };
            if (event.statusText === undefined) delete thread[event.statusKey];
            else thread[event.statusKey] = event.statusText;
            return { statuses: { ...s.statuses, [threadId]: thread } };
          });
        } else if (event.kind === "setWidget") {
          // Keyed composer widget; absent widgetLines clears that key.
          set((s) => {
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
          get().setDraft(threadId, event.text);
        } else if (event.kind === "tool" && event.phase === "end") {
          // Tool output is added to context, so the usage bar slides (HOY-208).
          void get().refreshStats(threadId);
        } else if (event.kind === "status" && event.label === "compacting") {
          // Compaction rewrites context; refresh after it's done (the next
          // text/tool event will update the bar; this is a best-effort interim).
          void get().refreshStats(threadId);
        }
      };

      await sendPrompt(sessionId, outbound, channel, images);
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
      set({ projects, drafts });
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
  },

  unarchiveThread: (threadId) =>
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        archived: false,
      })),
    })),

  deleteThread: (threadId) => {
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

// Monotonic id for transient extension `notify` notices, so each can be
// dismissed (by click or auto-expiry) without colliding.
let noticeSeq = 0;
const NOTICE_TTL_MS = 6000;

function acquireSession(
  threadId: string,
  cwd: string,
  sessionFile: string | null | undefined,
): Promise<string> {
  const existing = pendingSessions.get(threadId);
  if (existing) return existing;
  const spawn = createSession(cwd, sessionFile ?? null).finally(() =>
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
): void {
  const payload = {
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
  if (state.projects === prev.projects && state.drafts === prev.drafts) return;
  if (!hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Read at fire time: the debounce window may batch several changes, and
    // the untouched filter needs the turns that exist when the write happens.
    const s = useSessionStore.getState();
    persistProjects(s.projects, s.turns, s.drafts);
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
