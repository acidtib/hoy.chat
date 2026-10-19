import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// HOY-312: when a deferred thinking pick is unsupported by the newly selected
// model's getSupportedThinkingLevels, the store should coalesce locally to a
// supported level without sending the unsupported value.

const setThinkingLevel = mock<(sessionId: string, level: string) => Promise<unknown>>();
const setModel = mock<(sessionId: string, provider: string, modelId: string) => Promise<unknown>>();
const createSession = mock<() => Promise<string>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const sendPrompt = mock<() => Promise<void>>();
const getMessages = mock<() => Promise<unknown[]>>();

mockIpcModule({
  setThinkingLevel,
  setModel,
  createSession,
  getState,
  sendPrompt,
  getMessages,
});

const { useSessionStore } = await import("@/state/store");

function seed(thread: Partial<Thread>, models: unknown[] = []) {
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
    models: models as never,
  });
}

function thread(): Thread {
  return useSessionStore.getState().projects[0].threads[0];
}

beforeEach(() => {
  setThinkingLevel.mockReset();
  setModel.mockReset();
  createSession.mockReset();
  getState.mockReset();
  sendPrompt.mockReset();
  getMessages.mockReset();
});

describe("HOY-312 coalesce on model change", () => {
  test("selectModel coalesces unsupported thinkingLevel locally (xhigh -> high) without sending unsupported", async () => {
    // Model that only supports low/medium/high (xAI-style)
    const restrictiveModel = {
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
    };
    seed({ sessionId: "sess_coalesce", thinkingLevel: "xhigh" }, [restrictiveModel]);
    setModel.mockResolvedValue({});
    setThinkingLevel.mockResolvedValue({});
    getState.mockResolvedValue({ thinkingLevel: "high" });

    await useSessionStore.getState().selectModel("t1", "xai", "grok-4.5");

    // Thinking should be coalesced to high (preferred fallback), not remain xhigh
    expect(thread().thinkingLevel).toBe("high");
    // And setThinkingLevel should have been called with high, never with xhigh
    if (setThinkingLevel.mock.calls.length > 0) {
      for (const call of setThinkingLevel.mock.calls) {
        expect(call[1]).not.toBe("xhigh");
      }
      expect(setThinkingLevel).toHaveBeenCalledWith("sess_coalesce", "high");
    }
  });

  test("selectModel coalesces to off for non-reasoning model", async () => {
    const nonReasoning = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      reasoning: false,
    };
    seed({ sessionId: "sess_non_reason", thinkingLevel: "high" }, [nonReasoning]);
    setModel.mockResolvedValue({});
    setThinkingLevel.mockResolvedValue({});
    getState.mockResolvedValue({ thinkingLevel: "off" });

    await useSessionStore.getState().selectModel("t1", "openai", "gpt-4o");

    expect(thread().thinkingLevel).toBe("off");
  });

  test("applyThreadModel does not send unsupported deferred pick at spawn", async () => {
    const restrictive = {
      id: "grok-4.5",
      name: "Grok 4.5",
      provider: "xai",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
    };
    // Deferred pick xhigh, model truth is grok-4.5 which does not support xhigh
    seed({ sessionId: null, thinkingLevel: "xhigh", model: { provider: "xai", id: "grok-4.5" } }, [restrictive]);
    createSession.mockResolvedValue("sess_deferred");
    // First getState returns grok-4.5 as current model with high, second after thinking set returns high
    getState
      .mockResolvedValueOnce({ model: { provider: "xai", id: "grok-4.5" }, thinkingLevel: "high" })
      .mockResolvedValueOnce({ thinkingLevel: "high" });
    setThinkingLevel.mockResolvedValue({});
    sendPrompt.mockResolvedValue(undefined);

    await useSessionStore.getState().submitPrompt("t1", "hello");

    // Should not have attempted to send xhigh; should send coalesced high
    for (const call of setThinkingLevel.mock.calls) {
      expect(call[1]).not.toBe("xhigh");
    }
    expect(thread().thinkingLevel).toBe("high");
  });

  test("applyThreadModel clamps against the pick, not the session truth", async () => {
    const nonReasoning = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      reasoning: false,
    };
    // Deferred pick is a non-reasoning model; the session truth is a reasoning
    // model that supports "high". The clamp must target the pick so the stale
    // "high" is corrected before setModel switches to the restrictive model.
    seed(
      {
        sessionId: null,
        thinkingLevel: "high",
        model: { provider: "openai", id: "gpt-4o" },
      },
      [nonReasoning],
    );
    createSession.mockResolvedValue("sess_pick_truth");
    // First getState returns the reasoning truth with high; second returns the
    // level after setThinkingLevel (off).
    getState
      .mockResolvedValueOnce({
        model: { provider: "anthropic", id: "claude-opus-4-8" },
        thinkingLevel: "high",
      })
      .mockResolvedValueOnce({ thinkingLevel: "off" });
    setThinkingLevel.mockResolvedValue({});
    setModel.mockResolvedValue({});
    sendPrompt.mockResolvedValue(undefined);

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(thread().thinkingLevel).toBe("off");
    for (const call of setThinkingLevel.mock.calls) {
      expect(call[1]).not.toBe("high");
    }
    expect(setThinkingLevel).toHaveBeenCalledWith("sess_pick_truth", "off");
  });
});
