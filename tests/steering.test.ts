import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

const sendPrompt =
  mock<
    (
      sessionId: string,
      message: string,
      channel: unknown,
      images?: unknown,
      behavior?: string,
    ) => Promise<void>
  >();
const enqueuePrompt =
  mock<
    (
      sessionId: string,
      message: string,
      images: unknown,
      behavior: string,
    ) => Promise<void>
  >();
const getState = mock<(sessionId: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, enqueuePrompt, getState });

const { useSessionStore } = await import("@/state/store");

function seed(thread: Partial<Thread> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          {
            id: "t1",
            title: "Thread",
            updatedAt: 0,
            sessionId: "sess_live",
            ...thread,
          },
        ],
      },
    ],
    panels: [{ id: "t1", width: 1 }],
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
  });
}

function turnCount(): number {
  return (useSessionStore.getState().turns["t1"] ?? []).length;
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  enqueuePrompt.mockReset();
  enqueuePrompt.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
});

describe("submitPrompt steering (HOY-218)", () => {
  test("idle send: no streamingBehavior, fresh channel, assistant turn appended", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const [sessionId, message, , , behavior] = sendPrompt.mock.calls[0];
    expect(sessionId).toBe("sess_live");
    expect(message).toBe("hello");
    expect(behavior).toBeUndefined();
    // user turn + in-flight assistant turn
    expect(turnCount()).toBe(2);
    expect(useSessionStore.getState().streaming["t1"]).toBe(true);
  });

  test("streaming + Enter: enqueues a steer, no new channel, no new turn", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    const before = turnCount();

    await useSessionStore.getState().submitPrompt("t1", "go left", undefined, "steer");

    // No second sendPrompt (no new channel / sink swap); the steer goes over the
    // no-channel enqueue path, and no transcript turn is appended.
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(enqueuePrompt).toHaveBeenCalledTimes(1);
    const [sessionId, message, , behavior] = enqueuePrompt.mock.calls[0];
    expect(sessionId).toBe("sess_live");
    expect(message).toBe("go left");
    expect(behavior).toBe("steer");
    expect(turnCount()).toBe(before);
  });

  test("streaming + Shift+Enter: enqueues a followUp", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    await useSessionStore
      .getState()
      .submitPrompt("t1", "then this", undefined, "followUp");

    expect(enqueuePrompt.mock.calls[0][3]).toBe("followUp");
  });

  test("race: streaming flag already cleared falls back to the idle path", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    const before = turnCount();
    // Simulate Done landing between the flag read and the next send.
    useSessionStore.setState((s) => ({ streaming: { ...s.streaming, t1: false } }));

    await useSessionStore.getState().submitPrompt("t1", "new turn", undefined, "steer");

    // Idle path: a fresh assistant turn + a new sendPrompt with no behavior; the
    // enqueue path is not used.
    expect(turnCount()).toBe(before + 2);
    expect(enqueuePrompt).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt.mock.calls[1][4]).toBeUndefined();
  });

  test("a failed enqueue surfaces in threadErrors", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    enqueuePrompt.mockRejectedValueOnce(new Error("sidecar gone"));

    await useSessionStore.getState().submitPrompt("t1", "steer me", undefined, "steer");

    expect(useSessionStore.getState().threadErrors["t1"]).toContain("sidecar gone");
  });
});
