import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// HOY-204: selectThinkingLevel and the deferred-pick reconcile at spawn,
// mirroring modelSelection.test.ts.
const setThinkingLevel =
  mock<(sessionId: string, level: string) => Promise<unknown>>();
const createSession = mock<() => Promise<string>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const sendPrompt = mock<() => Promise<void>>();
const getMessages = mock<() => Promise<unknown[]>>();

mockIpcModule({
  setThinkingLevel,
  createSession,
  getState,
  sendPrompt,
  getMessages,
});

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
  setThinkingLevel.mockReset();
  createSession.mockReset();
  getState.mockReset();
  sendPrompt.mockReset();
  getMessages.mockReset();
});

describe("selectThinkingLevel", () => {
  test("live session: set_thinking_level goes to the sidecar; thread updates", async () => {
    seed({ sessionId: "sess_think_live" });
    setThinkingLevel.mockResolvedValue({});

    await useSessionStore.getState().selectThinkingLevel("t1", "low");

    expect(setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(setThinkingLevel).toHaveBeenCalledWith("sess_think_live", "low");
    expect(thread().thinkingLevel).toBe("low");
  });

  test("no session: defers without calling set_thinking_level", async () => {
    seed({ sessionId: null });

    await useSessionStore.getState().selectThinkingLevel("t1", "minimal");

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(thread().thinkingLevel).toBe("minimal");
  });

  test("rejection lands in threadErrors and snaps back to the session truth", async () => {
    seed({ sessionId: "sess_think_err", thinkingLevel: "high" });
    setThinkingLevel.mockRejectedValue(new Error("xhigh not supported"));
    getState.mockResolvedValue({ thinkingLevel: "high" });

    await useSessionStore.getState().selectThinkingLevel("t1", "xhigh");

    const state = useSessionStore.getState();
    expect(state.threadErrors["t1"]).toContain("xhigh not supported");
    expect(thread().thinkingLevel).toBe("high");
  });
});

// Session ids are unique per test: the modelApplied guard is module-level.
describe("deferred pick at spawn", () => {
  test("submitPrompt applies a deferred differing pick before sending", async () => {
    seed({ sessionId: null, thinkingLevel: "low" });
    const order: string[] = [];
    createSession.mockResolvedValue("sess_think_a");
    getState.mockResolvedValue({ thinkingLevel: "high" });
    setThinkingLevel.mockImplementation(async () => {
      order.push("set_thinking_level");
      return {};
    });
    sendPrompt.mockImplementation(async () => {
      order.push("send_prompt");
    });

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setThinkingLevel).toHaveBeenCalledWith("sess_think_a", "low");
    expect(order).toEqual(["set_thinking_level", "send_prompt"]);
    expect(thread().thinkingLevel).toBe("low");
  });

  test("matching pick: no redundant call; no pick adopts pi's level", async () => {
    seed({ sessionId: null, thinkingLevel: null });
    createSession.mockResolvedValue("sess_think_b");
    getState.mockResolvedValue({ thinkingLevel: "medium" });
    sendPrompt.mockResolvedValue(undefined);

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(thread().thinkingLevel).toBe("medium");
  });
});
