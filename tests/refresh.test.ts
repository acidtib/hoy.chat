import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelInfo, ProviderAuth, ProviderInfo } from "@/lib/types";

// Mock the ipc module before anything imports it. The mock carries every export
// the store needs at import time, but only the three provider calls matter here.
const listModels = mock<() => Promise<ModelInfo[]>>();
const providerStatuses = mock<(ids: string[]) => Promise<ProviderAuth[]>>();
const supportedProviders = mock<() => Promise<ProviderInfo[]>>();

mock.module("@/lib/ipc", () => ({
  Channel: class {},
  listModels,
  providerStatuses,
  supportedProviders,
  closeSession: mock(),
  createSession: mock(),
  deleteSessionFile: mock(),
  getMessages: mock(),
  getSessionStats: mock(),
  loadWorkspace: mock(),
  saveWorkspace: mock(),
  sendPrompt: mock(),
  abort: mock(),
  activeSessionId: mock(),
  getState: mock(),
  pickDirectory: mock(),
  removeProviderKey: mock(),
  saveProviderKey: mock(),
  setModel: mock(),
}));

const { useSessionStore } = await import("@/state/store");
const { refreshProviderData } = await import("@/lib/refresh");

const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini", env: "GEMINI_API_KEY" },
];
const AUTH: ProviderAuth[] = [
  {
    provider: "anthropic",
    configured: true,
    kind: "api_key",
    source: "authFile",
    removable: true,
  },
];
const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-opus-4-8" } as ModelInfo,
];

beforeEach(() => {
  listModels.mockReset();
  providerStatuses.mockReset();
  supportedProviders.mockReset();
  useSessionStore.setState({
    supportedProviders: [],
    providerAuth: [],
    models: [],
  });
});

describe("refreshProviderData", () => {
  test("fetches providers when the store is empty, then statuses and models", async () => {
    supportedProviders.mockResolvedValue(PROVIDERS);
    providerStatuses.mockResolvedValue(AUTH);
    listModels.mockResolvedValue(MODELS);

    await refreshProviderData();

    expect(supportedProviders).toHaveBeenCalledTimes(1);
    expect(providerStatuses).toHaveBeenCalledWith(["anthropic", "google"]);
    const state = useSessionStore.getState();
    expect(state.supportedProviders).toEqual(PROVIDERS);
    expect(state.providerAuth).toEqual(AUTH);
    expect(state.models).toEqual(MODELS);
  });

  test("skips the provider fetch when the store already has the list", async () => {
    useSessionStore.setState({ supportedProviders: PROVIDERS });
    providerStatuses.mockResolvedValue(AUTH);
    listModels.mockResolvedValue(MODELS);

    await refreshProviderData();

    expect(supportedProviders).not.toHaveBeenCalled();
    expect(providerStatuses).toHaveBeenCalledWith(["anthropic", "google"]);
  });

  test("swallows a listModels failure; auth still refreshes, models untouched", async () => {
    useSessionStore.setState({ supportedProviders: PROVIDERS });
    providerStatuses.mockResolvedValue(AUTH);
    listModels.mockRejectedValue(new Error("no active session for list_models"));

    await refreshProviderData();

    const state = useSessionStore.getState();
    expect(state.providerAuth).toEqual(AUTH);
    expect(state.models).toEqual([]);
  });
});
