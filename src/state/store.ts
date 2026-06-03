import { create } from "zustand";
import type { SessionMeta } from "@/lib/types";

// Session list is keyed by sessionId from the start so multi-session is a data
// change, not a redesign. MVP carries exactly one session.
interface SessionStore {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  setSessions: (sessions: SessionMeta[]) => void;
  setActiveSessionId: (id: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
}));
