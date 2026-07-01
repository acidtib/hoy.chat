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
const getState = mock<(sessionId: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, getState });

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

  test("streaming + Enter: steer on the same channel, no new turn", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    const idleChannel = sendPrompt.mock.calls[0][2];
    const before = turnCount();

    await useSessionStore.getState().submitPrompt("t1", "go left", undefined, "steer");

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    const [, message, channel, , behavior] = sendPrompt.mock.calls[1];
    expect(message).toBe("go left");
    expect(behavior).toBe("steer");
    expect(channel).toBe(idleChannel);
    // Queued messages do not append a transcript turn.
    expect(turnCount()).toBe(before);
  });

  test("streaming + Shift+Enter: followUp on the same channel", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    await useSessionStore
      .getState()
      .submitPrompt("t1", "then this", undefined, "followUp");

    expect(sendPrompt.mock.calls[1][4]).toBe("followUp");
  });

  test("race: streaming flag already cleared falls back to the idle path", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    const before = turnCount();
    // Simulate Done landing between the flag read and the next send.
    useSessionStore.setState((s) => ({ streaming: { ...s.streaming, t1: false } }));

    await useSessionStore.getState().submitPrompt("t1", "new turn", undefined, "steer");

    // Idle path: a fresh assistant turn is appended and no behavior is sent.
    expect(turnCount()).toBe(before + 2);
    expect(sendPrompt.mock.calls[1][4]).toBeUndefined();
  });

  test("'already processing' rejection retries once as a follow-up", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "hello");
    sendPrompt.mockReset();
    sendPrompt
      .mockRejectedValueOnce(new Error("Agent is already processing. Specify..."))
      .mockResolvedValueOnce(undefined);

    await useSessionStore.getState().submitPrompt("t1", "squeeze in", undefined, "steer");

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt.mock.calls[0][4]).toBe("steer");
    expect(sendPrompt.mock.calls[1][4]).toBe("followUp");
    expect(useSessionStore.getState().threadErrors["t1"]).toBeFalsy();
  });
});
