import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent, Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// HOY-300 Task 5: a parent that issues a synchronous spawn (subagentSpawnSync)
// is about to block on ctx.ui.input awaiting its child. If that parent is
// itself a running subagent (holds a runningAgents slot), it must release the
// slot before the child spawns — otherwise a full concurrency cap deadlocks a
// deep tree (every slot held by an agent blocked on a queued descendant).
//
// This drives the exact store path the real event handler uses: start a live
// turn on the parent to capture its channel (mirrors queue.test.ts), then feed
// the channel a subagentSpawnSync event, exactly as streamPromptOnThread's
// channel.onmessage does in production.

const sendPrompt =
  mock<(sessionId: string, message: string, channel: unknown) => Promise<void>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, getState });

const { useSessionStore } = await import("@/state/store");
const { usePrefsStore } = await import("@/state/prefs");

function seed(thread: Partial<Thread> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "proj1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          {
            id: "p1",
            title: "Parent",
            updatedAt: 0,
            sessionId: "sess_p1",
            ...thread,
          },
          {
            id: "qc1",
            title: "Queued child",
            updatedAt: 0,
            sessionId: null,
            parentThreadId: "p1",
          },
        ],
      },
    ],
    panels: [{ id: "p1", width: 1 }],
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
    // Explicit rather than relying on the store's initial default: other test
    // files in this shared-module suite (e.g. refresh.test.ts) can leave the
    // singleton store's `subagents` as whatever their own unmocked
    // listSubagents call resolved to, and spawnChildThread reads this field.
    subagents: [],
    // p1 is itself a running subagent (depth >= 1) with a full concurrency
    // cap (1/1), and qc1 is a sibling/other descendant already queued behind
    // it, waiting for a slot.
    runningAgents: new Set(["p1"]),
    agentQueue: ["qc1"],
    queuedPayloads: {
      qc1: {
        payload: {
          agentId: "a-queued",
          subagentType: "Explore",
          task: "queued task",
          requestId: "",
        },
        childDepth: 1,
      },
    },
  });
}

// Start a turn so a live channel exists, and return its onmessage handler.
async function startTurn(threadId: string): Promise<(event: AgentEvent) => void> {
  await useSessionStore.getState().submitPrompt(threadId, "hello");
  const call = sendPrompt.mock.calls.find((c) => c[0] === "sess_p1")!;
  const channel = call[2] as { onmessage: (e: AgentEvent) => void };
  return (event) => channel.onmessage(event);
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  usePrefsStore.getState().setPref("maxConcurrentAgents", 1);
  seed();
});

describe("subagentSpawnSync releases the parent's concurrency slot (HOY-300)", () => {
  test("a blocked parent's slot is released and the queued sibling is pumped in", async () => {
    const emit = await startTurn("p1");

    emit({
      kind: "subagentSpawnSync",
      requestId: "req1",
      agentId: "a1",
      subagentType: "Explore",
      task: "child task",
    });

    // p1 is about to block on ctx.ui.input; it must not keep holding its slot.
    expect(useSessionStore.getState().runningAgents.has("p1")).toBe(false);
    // The queued sibling was waiting for exactly this: freeing the slot must
    // pump it in.
    expect(useSessionStore.getState().runningAgents.has("qc1")).toBe(true);

    // The cap (1) is now spent again by qc1, so the newly spawned child from
    // the subagentSpawnSync event itself has to queue behind it — proof the
    // release+pump ran BEFORE the new spawn attempted to take a slot.
    const newChildId = useSessionStore
      .getState()
      .projects[0].threads.map((t) => t.id)
      .find((id) => id !== "p1" && id !== "qc1")!;
    expect(newChildId).toBeDefined();
    expect(useSessionStore.getState().runningAgents.has(newChildId)).toBe(false);
    expect(useSessionStore.getState().agentQueue).toContain(newChildId);
  });
});
