import { beforeEach, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";
import {
  recordSubagentRequest,
  takeSubagentRequest,
} from "@/state/subagent-requests";

// HOY-300 Task 4: on the child's `done`, the store answers the parent's
// blocked `agent`-tool request in-band instead of the old HOY-233
// turn-injection delivery. This exercises respondSubagentResult directly
// (the unit the done handler now calls), mocking @/lib/ipc.respondPermission
// to assert what the blocked ctx.ui.input is resolved with.
const respondPermission =
  mock<
    (
      sessionId: string,
      requestId: string,
      answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ) => Promise<void>
  >();

mockIpcModule({ respondPermission });

const { useSessionStore, respondSubagentResult } = await import(
  "@/state/store"
);

function seed(): void {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          {
            id: "ps",
            title: "Parent",
            updatedAt: 0,
            sessionId: "ps",
          } as Thread,
          {
            id: "c1",
            title: "Child",
            updatedAt: 0,
            sessionId: "sess_c1",
            parentThreadId: "ps",
            spawnedBy: { type: "Explore", agentId: "a1" },
          } as Thread,
        ],
      },
    ],
    panels: [
      { id: "ps", width: 600 },
      { id: "c1", width: 600 },
    ],
    turns: {
      c1: [
        {
          role: "assistant",
          blocks: [{ kind: "text", content: "DONE" }],
          streaming: false,
        },
      ],
    },
    streaming: {},
    stats: {},
    threadErrors: {},
    modelSelecting: {},
    pendingPermissions: {},
    drafts: {},
  });
}

function child(): Thread {
  return useSessionStore
    .getState()
    .projects[0].threads.find((t) => t.id === "c1")!;
}

beforeEach(() => {
  respondPermission.mockReset();
  respondPermission.mockResolvedValue();
  seed();
});

test("a finished child answers the parent's blocked request in-band with its result", () => {
  recordSubagentRequest("c1", {
    parentThreadId: "ps",
    parentSessionId: "ps",
    requestId: "req1",
  });

  respondSubagentResult("c1");

  expect(respondPermission).toHaveBeenCalledTimes(1);
  const [sessionId, requestId, answer] = respondPermission.mock.calls[0];
  expect(sessionId).toBe("ps");
  expect(requestId).toBe("req1");
  expect(answer.value).toContain("DONE");

  // The mapping is consumed: a re-entrant done cannot double-answer.
  expect(takeSubagentRequest("c1")).toBeUndefined();
  // Terminal + panel-closed parity with the old delivery flow.
  expect(child().completedAt).toBeTruthy();
  expect(
    useSessionStore.getState().panels.some((p) => p.id === "c1"),
  ).toBe(false);
});

test("an async-spawned child (no recorded request) is a no-op", () => {
  respondSubagentResult("c1");

  expect(respondPermission).not.toHaveBeenCalled();
});
