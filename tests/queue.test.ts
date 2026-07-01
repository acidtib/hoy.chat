import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent, Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

const sendPrompt =
  mock<(sessionId: string, message: string, channel: unknown) => Promise<void>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const closeSession = mock<() => Promise<void>>();

mockIpcModule({ sendPrompt, getState, closeSession });

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
    pendingPermissions: {},
    notices: {},
    statuses: {},
    widgets: {},
    drafts: {},
  });
}

// Start a turn so a live channel exists, and return its onmessage handler.
async function startTurn(): Promise<(event: AgentEvent) => void> {
  await useSessionStore.getState().submitPrompt("t1", "hello");
  const channel = sendPrompt.mock.calls[0][2] as { onmessage: (e: AgentEvent) => void };
  return (event) => channel.onmessage(event);
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  closeSession.mockReset();
  closeSession.mockResolvedValue(undefined);
});

describe("queueUpdate handling (HOY-218)", () => {
  test("accumulates the steering and follow-up queues", async () => {
    seed();
    const emit = await startTurn();
    emit({ kind: "queueUpdate", steering: ["left"], followUp: ["after"] });

    expect(useSessionStore.getState().queued["t1"]).toEqual({
      steering: ["left"],
      followUp: ["after"],
    });
  });

  test("replaces rather than appends (Pi sends full arrays)", async () => {
    seed();
    const emit = await startTurn();
    emit({ kind: "queueUpdate", steering: ["a", "b"], followUp: [] });
    emit({ kind: "queueUpdate", steering: ["b"], followUp: [] });

    expect(useSessionStore.getState().queued["t1"].steering).toEqual(["b"]);
  });

  test("a delivered queued message becomes a user turn + fresh assistant turn", async () => {
    seed();
    const emit = await startTurn();
    // Enqueue (chip only, no transcript change yet).
    emit({ kind: "queueUpdate", steering: ["do X"], followUp: [] });
    let turns = useSessionStore.getState().turns["t1"];
    expect(turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual([
      "hello",
    ]);

    // Pi delivers it (removed from the queue).
    emit({ kind: "queueUpdate", steering: [], followUp: [] });
    turns = useSessionStore.getState().turns["t1"];
    expect(turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual([
      "hello",
      "do X",
    ]);
    // A fresh streaming assistant turn is opened for the response.
    const last = turns[turns.length - 1];
    expect(last.role).toBe("assistant");
    if (last.role === "assistant") expect(last.streaming).toBe(true);
  });

  test("abort leaves the queue intact (Pi keeps it for the next turn)", async () => {
    seed();
    const emit = await startTurn();
    emit({ kind: "queueUpdate", steering: ["keep"], followUp: [] });
    emit({ kind: "aborted" });
    emit({ kind: "done" });

    expect(useSessionStore.getState().streaming["t1"]).toBe(false);
    expect(useSessionStore.getState().queued["t1"]).toEqual({
      steering: ["keep"],
      followUp: [],
    });
  });

  test("closing the panel drops the queue", async () => {
    seed();
    const emit = await startTurn();
    emit({ kind: "queueUpdate", steering: ["gone"], followUp: [] });

    useSessionStore.getState().closePanel("t1");

    expect(useSessionStore.getState().queued["t1"]).toBeUndefined();
  });
});
