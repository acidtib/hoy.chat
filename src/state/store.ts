import { create } from "zustand";
import {
  Channel,
  closeSession,
  createSession,
  deleteSessionFile,
  getMessages,
  getSessionStats,
  getState,
  loadWorkspace,
  saveWorkspace,
  sendPrompt,
  setModel,
} from "@/lib/ipc";
import { applyEvent, messagesToTurns } from "@/lib/turns";
import type {
  AgentEvent,
  ModelInfo,
  ModelRef,
  Project,
  ProviderAuth,
  ProviderInfo,
  SessionStats,
  Thread,
  Turn,
} from "@/lib/types";

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

  openThread: (id: string) => void;
  closePanel: (id: string) => void;
  setBodyWidth: (width: number) => void;
  resizePanelEdge: (index: number, deltaPx: number) => void;
  toggleSidebar: () => void;
  setSidebarView: (view: "projects" | "history") => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  addProject: (path: string) => void;
  addThread: (projectId: string) => string;
  removeProject: (projectId: string) => void;

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

  // M4 persistence + lifecycle.
  initWorkspace: () => Promise<void>;
  hydrateThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => void;
  archiveThread: (threadId: string) => void;
  unarchiveThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;

  submitPrompt: (threadId: string, message: string) => Promise<void>;
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

  // Open the thread in a panel, or just focus it if it's already open. A
  // persisted thread (has a sessionFile, no live sidecar, nothing loaded) is
  // hydrated from disk in the background.
  openThread: (id) => {
    set((s) => {
      if (s.panels.some((p) => p.id === id)) return { activeThreadId: id };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return { panels: [...panels, { id, width }], activeThreadId: id };
    });
    void get().hydrateThread(id);
  },

  closePanel: (id) => {
    // Kill-on-close: tear down the live sidecar and drop the cached transcript so
    // reopening re-spawns and reloads from disk. The durable sessionFile stays on
    // the thread, so the conversation is not lost.
    const live = findThread(get().projects, id)?.thread.sessionId;
    if (live) void closeSession(live);
    // Abandon the streaming channel so the killed sidecar's trailing error/done
    // events are ignored rather than re-populating this thread's state.
    activeChannels.delete(id);
    set((s) => {
      const index = s.panels.findIndex((p) => p.id === id);
      if (index < 0) return s;
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
      // thread.model survives the close on purpose: a pending pick should still
      // apply when the thread is reopened and prompted.
      return {
        panels,
        activeThreadId,
        turns,
        stats,
        streaming,
        threadErrors,
        modelSelecting,
        projects: patchThread(s.projects, id, (th) => ({ ...th, sessionId: null })),
      };
    });
  },

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
    set((s) => {
      if (s.projects.some((p) => p.path === path)) return s;
      return {
        projects: [...s.projects, { id: newId("p"), name, path, threads: [] }],
      };
    });
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
      if (t.sessionId) void closeSession(t.sessionId);
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
      if (thread.sessionId) {
        await setModel(thread.sessionId, provider, modelId);
        // Pi persists the pick as the global defaultModel on every set_model,
        // so mirror that here for threads still showing the default.
        set((s) => ({
          defaultModel: pick,
          projects: patchThread(s.projects, threadId, (th) => ({
            ...th,
            model: pick,
          })),
        }));
      } else {
        // Defer, don't spawn: the pick is applied by the session-spawn path.
        // defaultModel stays; Pi hasn't persisted anything yet.
        set((s) => ({
          projects: patchThread(s.projects, threadId, (th) => ({
            ...th,
            model: pick,
          })),
        }));
      }
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

  // Send a prompt from a thread panel and stream the response into its turns.
  // Lazily spawns the thread's own sidecar (session per thread) in the project's
  // cwd on first send, then drives one Channel per turn.
  submitPrompt: async (threadId, message) => {
    const text = message.trim();
    if (!text || get().streaming[threadId]) return;

    const found = findThread(get().projects, threadId);
    if (!found) return;
    const { thread, project } = found;

    // Append the user turn plus an in-flight assistant turn the events fold into.
    // Title an untitled thread from its first message.
    set((s) => ({
      turns: {
        ...s.turns,
        [threadId]: [
          ...(s.turns[threadId] ?? []),
          { role: "user", text },
          { role: "assistant", tools: [], text: "", streaming: true },
        ],
      },
      streaming: { ...s.streaming, [threadId]: true },
      threadErrors: { ...s.threadErrors, [threadId]: null },
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        updatedAt: Date.now(),
        title: th.title === "New thread" ? truncateTitle(text) : th.title,
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
        if (event.kind === "done") {
          activeChannels.delete(threadId);
          stopStreaming();
          void get().refreshStats(threadId);
        } else if (event.kind === "error") {
          set((s) => ({
            threadErrors: { ...s.threadErrors, [threadId]: event.message },
          }));
        }
      };

      await sendPrompt(sessionId, text, channel);
    } catch (e) {
      activeChannels.delete(threadId);
      stopStreaming();
      set((s) => {
        const list = s.turns[threadId] ?? [];
        const last = list[list.length - 1];
        const turns =
          last && last.role === "assistant"
            ? {
                ...s.turns,
                [threadId]: [
                  ...list.slice(0, -1),
                  { ...last, streaming: false },
                ],
              }
            : s.turns;
        return { turns, threadErrors: { ...s.threadErrors, [threadId]: String(e) } };
      });
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
      set({ projects: ws.projects ?? [] });
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
      // Reconcile the thread's model with the restored session off the critical
      // path; hydration must not block the transcript restore.
      void applyThreadModel(threadId, sessionId).catch((e) => {
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

  // Persisted through the autosave (title is in the workspace allowlist).
  renameThread: (threadId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({
        ...th,
        title: trimmed,
      })),
    }));
  },

  archiveThread: (threadId) => {
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
    if (thread?.sessionId) void closeSession(thread.sessionId);
    if (thread?.sessionFile) void deleteSessionFile(thread.sessionFile);
    get().closePanel(threadId);
    set((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        threads: p.threads.filter((t) => t.id !== threadId),
      })),
    }));
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
// second call returns while the first is still in flight. Session ids are never
// reused, so no cleanup is needed.
const modelApplied = new Set<string>();

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
  const pick = findThread(store.getState().projects, threadId)?.thread.model ?? null;
  const piState = await getState(sessionId);
  const truth: ModelRef | null = piState.model
    ? { provider: piState.model.provider, id: piState.model.id }
    : null;

  const setThreadModel = (model: ModelRef | null) =>
    store.setState((s) => ({
      projects: patchThread(s.projects, threadId, (th) => ({ ...th, model })),
    }));

  if (!pick) {
    if (truth) setThreadModel(truth);
    return;
  }
  if (truth && truth.provider === pick.provider && truth.id === pick.id) return;

  try {
    await setModel(sessionId, pick.provider, pick.id);
    // Pi persisted the pick as the global defaultModel; mirror it.
    store.setState({ defaultModel: pick });
  } catch (e) {
    // Revert to the session truth so the selector snaps back and a
    // retry-after-fix starts clean.
    setThreadModel(truth);
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

function persistProjects(projects: Project[]): void {
  const payload = {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path ?? null,
      threads: p.threads.map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        sessionFile: t.sessionFile ?? null,
        archived: !!t.archived,
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
  if (state.projects === prev.projects) return;
  if (!hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistProjects(state.projects), 300);
});

// Locate a thread and its owning project by id. Threads live nested under
// projects; this is the one traversal submitPrompt/refreshStats share.
function findThread(
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
