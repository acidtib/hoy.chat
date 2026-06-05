import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

// Mock the ipc module before anything imports it. The mock carries every export
// the store needs at import time; only setModel matters here.
const setModel =
  mock<(sessionId: string, provider: string, modelId: string) => Promise<unknown>>();

mock.module("@/lib/ipc", () => ({
  Channel: class {},
  setModel,
  abort: mock(),
  activeSessionId: mock(),
  closeSession: mock(),
  createSession: mock(),
  deleteSessionFile: mock(),
  getMessages: mock(),
  getSessionStats: mock(),
  getState: mock(),
  listModels: mock(),
  loadWorkspace: mock(),
  pickDirectory: mock(),
  providerStatuses: mock(),
  removeProviderKey: mock(),
  saveProviderKey: mock(),
  saveWorkspace: mock(),
  sendPrompt: mock(),
  supportedProviders: mock(),
}));

const { useSessionStore } = await import("@/state/store");

function seed(thread: Partial<Thread>) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "Thread", updatedAt: 0, sessionId: null, ...thread },
        ],
      },
    ],
    panels: [],
    threadErrors: {},
    modelSelecting: {},
    defaultModel: null,
  });
}

function thread(): Thread {
  return useSessionStore.getState().projects[0].threads[0];
}

beforeEach(() => {
  setModel.mockReset();
});

describe("selectModel", () => {
  test("live session: set_model goes to the thread's own sessionId; thread.model and defaultModel update", async () => {
    seed({ sessionId: "sess_live" });
    setModel.mockResolvedValue({});

    await useSessionStore
      .getState()
      .selectModel("t1", "anthropic", "claude-opus-4-8");

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith(
      "sess_live",
      "anthropic",
      "claude-opus-4-8",
    );
    const state = useSessionStore.getState();
    expect(thread().model).toEqual({ provider: "anthropic", id: "claude-opus-4-8" });
    expect(state.defaultModel).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
    expect(state.modelSelecting["t1"]).toBeFalsy();
  });

  test("no session: defers without calling set_model; defaultModel untouched", async () => {
    seed({ sessionId: null });

    await useSessionStore.getState().selectModel("t1", "groq", "llama-3.3-70b");

    expect(setModel).not.toHaveBeenCalled();
    expect(thread().model).toEqual({ provider: "groq", id: "llama-3.3-70b" });
    expect(useSessionStore.getState().defaultModel).toBeNull();
  });

  test("rejection lands in threadErrors; model state unchanged", async () => {
    const prior = { provider: "anthropic", id: "claude-opus-4-8" };
    seed({ sessionId: "sess_live", model: prior });
    useSessionStore.setState({ defaultModel: prior });
    setModel.mockRejectedValue(new Error("No API key for groq/x"));

    await useSessionStore.getState().selectModel("t1", "groq", "x");

    const state = useSessionStore.getState();
    expect(state.threadErrors["t1"]).toContain("No API key for groq/x");
    expect(thread().model).toEqual(prior);
    expect(state.defaultModel).toEqual(prior);
    expect(state.modelSelecting["t1"]).toBeFalsy();
  });

  test("unknown thread: no-op, no set_model", async () => {
    seed({ sessionId: "sess_live" });

    await useSessionStore.getState().selectModel("missing", "anthropic", "m");

    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("closePanel model state", () => {
  test("keeps thread.model but drops modelSelecting with the other per-thread records", () => {
    const pick = { provider: "groq", id: "llama-3.3-70b" };
    seed({ sessionId: null, model: pick });
    useSessionStore.setState({
      panels: [{ id: "t1", width: 600 }],
      modelSelecting: { t1: true },
    });

    useSessionStore.getState().closePanel("t1");

    expect(thread().model).toEqual(pick);
    expect(useSessionStore.getState().modelSelecting["t1"]).toBeUndefined();
  });
});
