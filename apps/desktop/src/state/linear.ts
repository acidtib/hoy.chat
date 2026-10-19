// Linear connection status and per-project issue cache (HOY-346). Kept out of
// the session store: none of it is persisted, and the key itself never reaches
// the renderer (Rust holds it).

import { create } from "zustand";
import {
  linearConnect,
  linearDisconnect,
  linearIssues,
  linearOAuthCancel,
  linearOAuthConnect,
  linearStatus,
} from "@/lib/ipc";
import type { LinearIssue, LinearStatus } from "@/lib/types";

export interface IssueCache {
  items: LinearIssue[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

interface LinearStore {
  status: LinearStatus | null;
  issues: Record<string, IssueCache>;
  refreshStatus: () => Promise<void>;
  // Rejects with Linear's message so the settings form can show it.
  connect: (apiKey: string) => Promise<void>;
  connectOAuth: () => Promise<void>;
  cancelOAuth: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshIssues: (projectId: string, teamId: string) => Promise<void>;
}

export const EMPTY_ISSUES: IssueCache = {
  items: [],
  loading: false,
  error: null,
  fetchedAt: null,
};

export const useLinearStore = create<LinearStore>((set, get) => ({
  status: null,
  issues: {},

  refreshStatus: async () => {
    try {
      set({ status: await linearStatus() });
    } catch (e) {
      set({
        status: {
          connected: false,
          method: null,
          viewerName: null,
          organization: null,
          error: String(e),
          oauthAvailable: false,
        },
      });
    }
  },

  connect: async (apiKey) => {
    const status = await linearConnect(apiKey);
    set({ status, issues: {} });
  },

  connectOAuth: async () => {
    const status = await linearOAuthConnect();
    set({ status, issues: {} });
  },

  cancelOAuth: () => linearOAuthCancel(),

  disconnect: async () => {
    await linearDisconnect();
    set((s) => ({
      status: {
        connected: false,
        method: null,
        viewerName: null,
        organization: null,
        error: null,
        oauthAvailable: s.status?.oauthAvailable ?? false,
      },
      issues: {},
    }));
  },

  refreshIssues: async (projectId, teamId) => {
    const prev = get().issues[projectId] ?? EMPTY_ISSUES;
    set((s) => ({
      issues: { ...s.issues, [projectId]: { ...prev, loading: true, error: null } },
    }));
    try {
      const items = await linearIssues(teamId);
      set((s) => ({
        issues: {
          ...s.issues,
          [projectId]: { items, loading: false, error: null, fetchedAt: Date.now() },
        },
      }));
    } catch (e) {
      set((s) => ({
        issues: {
          ...s.issues,
          [projectId]: { ...prev, loading: false, error: String(e) },
        },
      }));
    }
  },
}));
