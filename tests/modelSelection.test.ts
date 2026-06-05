import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// Named mocks these tests assert against; the shared helper fills in the rest
// of the ipc surface the store needs at import time.
const setModel =
  mock<(sessionId: string, provider: string, modelId: string) => Promise<unknown>>();
const createSession = mock<() => Promise<string>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const sendPrompt = mock<() => Promise<void>>();
const getMessages = mock<() => Promise<unknown[]>>();

mockIpcModule({ setModel, createSession, getState, sendPrompt, getMessages });

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
    turns: {},
    streaming: {},
    stats: {},
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
  createSession.mockReset();
  getState.mockReset();
  sendPrompt.mockReset();
  getMessages.mockReset();
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

// The modelApplied guard is module-level, so every test uses a distinct
// session id; session ids are never reused in the app either.
describe("applyThreadModel at spawn", () => {
  test("submitPrompt applies a deferred pick to the new session before sending", async () => {
    seed({
      sessionId: null,
      model: { provider: "groq", id: "llama-3.3-70b" },
    });
    const order: string[] = [];
    createSession.mockResolvedValue("sess_apply_a");
    getState.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    setModel.mockImplementation(async () => {
      order.push("set_model");
      return {};
    });
    sendPrompt.mockImplementation(async () => {
      order.push("send_prompt");
    });

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setModel).toHaveBeenCalledWith(
      "sess_apply_a",
      "groq",
      "llama-3.3-70b",
    );
    expect(order).toEqual(["set_model", "send_prompt"]);
    expect(useSessionStore.getState().defaultModel).toEqual({
      provider: "groq",
      id: "llama-3.3-70b",
    });
  });

  test("already-matching pick: no redundant set_model, prompt still sent", async () => {
    seed({
      sessionId: null,
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    createSession.mockResolvedValue("sess_apply_b");
    getState.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    sendPrompt.mockResolvedValue(undefined);

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setModel).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  test("restore hydration: no pick adopts the session's model, no set_model", async () => {
    seed({ sessionId: null, sessionFile: "/tmp/s.jsonl" });
    createSession.mockResolvedValue("sess_apply_c");
    getState.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    getMessages.mockResolvedValue([]);

    await useSessionStore.getState().hydrateThread("t1");
    // The model apply is fire-and-forget off the hydration path; flush it.
    await new Promise((r) => setTimeout(r, 0));

    expect(thread().model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  test("apply failure: prompt not sent, error surfaced, pick reverted to session truth", async () => {
    seed({ sessionId: null, model: { provider: "groq", id: "x" } });
    createSession.mockResolvedValue("sess_apply_d");
    getState.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    setModel.mockRejectedValue(new Error("No API key for groq/x"));

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(sendPrompt).not.toHaveBeenCalled();
    const state = useSessionStore.getState();
    expect(state.streaming["t1"]).toBe(false);
    expect(state.threadErrors["t1"]).toContain("No API key for groq/x");
    expect(thread().model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
  });
});

describe("applyThreadModel failure recovery", () => {
  test("a failed apply is retried on the next prompt instead of poisoning the guard", async () => {
    seed({ sessionId: null, model: { provider: "groq", id: "llama-3.3-70b" } });
    createSession.mockResolvedValue("sess_apply_retry");
    getState.mockRejectedValueOnce(new Error("rpc timeout"));

    await useSessionStore.getState().submitPrompt("t1", "hello");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useSessionStore.getState().threadErrors["t1"]).toContain("rpc timeout");

    // The transient failure clears; the retry must re-apply the pick.
    getState.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    });
    setModel.mockResolvedValue({});
    sendPrompt.mockResolvedValue(undefined);

    await useSessionStore.getState().submitPrompt("t1", "hello again");

    expect(setModel).toHaveBeenCalledWith(
      "sess_apply_retry",
      "groq",
      "llama-3.3-70b",
    );
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("closePanel model state", () => {
  test("keeps thread.model but drops modelSelecting with the other per-thread records", () => {
    const pick = { provider: "groq", id: "llama-3.3-70b" };
    // sessionFile marks the thread as touched; an untouched one is discarded
    // wholesale on close (HOY-184), pick and all.
    seed({ sessionId: null, sessionFile: "/tmp/s.jsonl", model: pick });
    useSessionStore.setState({
      panels: [{ id: "t1", width: 600 }],
      modelSelecting: { t1: true },
    });

    useSessionStore.getState().closePanel("t1");

    expect(thread().model).toEqual(pick);
    expect(useSessionStore.getState().modelSelecting["t1"]).toBeUndefined();
  });
});
