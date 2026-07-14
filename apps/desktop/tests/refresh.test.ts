import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelInfo, ProviderAuth, ProviderInfo } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// Named mocks for the three provider calls under test; the shared helper fills
// in the rest of the ipc surface the store needs at import time.
const listModels = mock<() => Promise<ModelInfo[]>>();
const providerStatuses = mock<(ids: string[]) => Promise<ProviderAuth[]>>();
const supportedProviders = mock<() => Promise<ProviderInfo[]>>();

mockIpcModule({ listModels, providerStatuses, supportedProviders });

const { useSessionStore } = await import("@/state/store");
const { refreshProviderData } = await import("@/lib/refresh");

const STATUS_IDS = [
  "anthropic",
  "google",
  "openai-codex",
  "github-copilot",
  "radius",
];

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
    expect(providerStatuses).toHaveBeenCalledWith(STATUS_IDS);
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
    expect(providerStatuses).toHaveBeenCalledWith(STATUS_IDS);
  });

  test("propagates a real listModels failure (timeout, crash) instead of swallowing it", async () => {
    useSessionStore.setState({ supportedProviders: PROVIDERS });
    providerStatuses.mockResolvedValue(AUTH);
    listModels.mockRejectedValue(new Error("sidecar request timed out after 15s"));

    await expect(refreshProviderData()).rejects.toThrow("timed out");
    // The independent statuses fetch still landed.
    expect(useSessionStore.getState().providerAuth).toEqual(AUTH);
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
