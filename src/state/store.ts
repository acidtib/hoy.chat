import { create } from "zustand";
import { SEEDED_THREAD_ID } from "@/lib/mock-conversation";
import type {
  ModelInfo,
  Project,
  ProviderAuth,
  ProviderInfo,
  Thread,
} from "@/lib/types";

const WEEK = 7 * 24 * 60 * 60 * 1000;

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

// Seed projects so the sidebar is tangible while project/thread persistence is
// still a frontend-only concept. Replaced by real data when the backend grows a
// projects/threads store (next milestone).
function seedProjects(): Project[] {
  const now = Date.now();
  return [
    { id: "p_jiji", name: "jiji", threads: [] },
    {
      id: "p_hoy",
      name: "hoy",
      threads: [
        {
          id: SEEDED_THREAD_ID,
          title: "lets work on ticket HOY-28",
          updatedAt: now - 3 * WEEK,
          sessionId: null,
        },
      ],
    },
  ];
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
  sidebarWidth: number;
  activeSessionId: string | null;
  models: ModelInfo[];
  supportedProviders: ProviderInfo[];
  providerAuth: ProviderAuth[];

  openThread: (id: string) => void;
  closePanel: (id: string) => void;
  setBodyWidth: (width: number) => void;
  resizePanelEdge: (index: number, deltaPx: number) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  addProject: (path: string) => void;
  addThread: (projectId: string) => string;
  removeProject: (projectId: string) => void;

  setActiveSessionId: (id: string | null) => void;
  setModels: (models: ModelInfo[]) => void;
  setSupportedProviders: (providers: ProviderInfo[]) => void;
  setProviderAuth: (providerAuth: ProviderAuth[]) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  projects: seedProjects(),
  panels: [],
  activeThreadId: null,
  bodyWidth: initialBodyWidth(),
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  activeSessionId: null,
  models: [],
  supportedProviders: [],
  providerAuth: [],

  // Open the thread in a panel, or just focus it if it's already open.
  openThread: (id) =>
    set((s) => {
      if (s.panels.some((p) => p.id === id)) return { activeThreadId: id };
      const { panels, width } = placeNewPanel(s.panels, s.bodyWidth);
      return { panels: [...panels, { id, width }], activeThreadId: id };
    }),

  closePanel: (id) =>
    set((s) => {
      const index = s.panels.findIndex((p) => p.id === id);
      if (index < 0) return s;
      // Grow the survivors to reclaim the closed panel's width, so closing
      // re-flows the strip instead of leaving a gap.
      const panels = growPanels(
        s.panels.filter((p) => p.id !== id),
        s.panels[index].width,
      );

      let activeThreadId = s.activeThreadId;
      if (activeThreadId === id) {
        const neighbor = panels[index] ?? panels[index - 1] ?? null;
        activeThreadId = neighbor?.id ?? null;
      }
      return { panels, activeThreadId };
    }),

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
  removeProject: (projectId) =>
    set((s) => {
      const removed = s.projects.find((p) => p.id === projectId);
      const ids = new Set(removed?.threads.map((t) => t.id) ?? []);
      const reclaimed = s.panels
        .filter((p) => ids.has(p.id))
        .reduce((a, p) => a + p.width, 0);
      // Re-flow the survivors into the removed panels' space, like closePanel.
      const panels = growPanels(
        s.panels.filter((p) => !ids.has(p.id)),
        reclaimed,
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
    }),

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setModels: (models) => set({ models }),
  setSupportedProviders: (supportedProviders) => set({ supportedProviders }),
  setProviderAuth: (providerAuth) => set({ providerAuth }),
}));
