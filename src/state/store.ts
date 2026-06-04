import { create } from "zustand";
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
          id: "t_hoy_1",
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
// Projects/threads drive the sidebar; activeThreadId is the UI selection
// (null = home page).
interface SessionStore {
  projects: Project[];
  activeThreadId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activeSessionId: string | null;
  models: ModelInfo[];
  supportedProviders: ProviderInfo[];
  providerAuth: ProviderAuth[];

  setActiveThreadId: (id: string | null) => void;
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

export const useSessionStore = create<SessionStore>((set) => ({
  projects: seedProjects(),
  activeThreadId: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  activeSessionId: null,
  models: [],
  supportedProviders: [],
  providerAuth: [],

  setActiveThreadId: (id) => set({ activeThreadId: id }),
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
      activeThreadId: thread.id,
    }));
    return thread.id;
  },
  removeProject: (projectId) =>
    set((s) => {
      const removed = s.projects.find((p) => p.id === projectId);
      const dropsActive = removed?.threads.some(
        (t) => t.id === s.activeThreadId,
      );
      return {
        projects: s.projects.filter((p) => p.id !== projectId),
        activeThreadId: dropsActive ? null : s.activeThreadId,
      };
    }),

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setModels: (models) => set({ models }),
  setSupportedProviders: (supportedProviders) => set({ supportedProviders }),
  setProviderAuth: (providerAuth) => set({ providerAuth }),
}));
