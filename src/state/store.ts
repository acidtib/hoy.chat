import { create } from "zustand";
import type { ModelInfo, ProviderAuth, SessionMeta } from "@/lib/types";

// Session list is keyed by sessionId from the start so multi-session is a data
// change, not a redesign. MVP carries exactly one session. Models and provider
// auth status are cached here so the top bar and settings modal render from our
// state, not from ad hoc fetches.
interface SessionStore {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  models: ModelInfo[];
  knownProviders: string[];
  providerAuth: ProviderAuth[];
  setSessions: (sessions: SessionMeta[]) => void;
  setActiveSessionId: (id: string | null) => void;
  setModels: (models: ModelInfo[]) => void;
  setKnownProviders: (providers: string[]) => void;
  setProviderAuth: (providerAuth: ProviderAuth[]) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  models: [],
  knownProviders: [],
  providerAuth: [],
  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setModels: (models) => set({ models }),
  setKnownProviders: (knownProviders) => set({ knownProviders }),
  setProviderAuth: (providerAuth) => set({ providerAuth }),
}));

// Distinct provider ids in first-seen order, derived from the model catalog.
export function providersFromModels(models: ModelInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (!seen.has(m.provider)) {
      seen.add(m.provider);
      out.push(m.provider);
    }
  }
  return out;
}

// Providers the settings picker offers: the curated known list first, unioned
// with any provider already in the catalog. get_available_models is gated to
// configured providers, so the known list is what lets a first-run user (empty
// auth.json, empty catalog) pick a provider to configure.
export function providerOptions(known: string[], models: ModelInfo[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...known, ...providersFromModels(models)]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
