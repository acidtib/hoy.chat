import { create } from "zustand";
import type { ModelInfo, ProviderAuth, ProviderInfo, SessionMeta } from "@/lib/types";

// Session list is keyed by sessionId from the start so multi-session is a data
// change, not a redesign. MVP carries exactly one session. Models, supported
// providers, and provider auth status are cached here so the top bar and settings
// page render from our state, not from ad hoc fetches.
interface SessionStore {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  models: ModelInfo[];
  supportedProviders: ProviderInfo[];
  providerAuth: ProviderAuth[];
  setSessions: (sessions: SessionMeta[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setModels: (models: ModelInfo[]) => void;
  setSupportedProviders: (providers: ProviderInfo[]) => void;
  setProviderAuth: (providerAuth: ProviderAuth[]) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  models: [],
  supportedProviders: [],
  providerAuth: [],
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setModels: (models) => set({ models }),
  setSupportedProviders: (supportedProviders) => set({ supportedProviders }),
  setProviderAuth: (providerAuth) => set({ providerAuth }),
}));
