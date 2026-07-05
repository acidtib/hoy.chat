import { beforeEach, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";
import { recordSubagentRequest, takeSubagentRequest } from "@/state/subagent-requests";

// HOY-300 Task 7: when a parent's turn is aborted, Rust's cancel_pending_ui
// already answers the parent's blocked ctx.ui.input as cancelled, but the
// child thread it spawned keeps running. stopStreaming on the parent must
// also stop the still-running child and drop its pending-request mapping so
// a late child `done` doesn't try to answer an already-cancelled request.
const abort = mock<(sessionId: string) => Promise<void>>();

mockIpcModule({ abort });

const { useSessionStore } = await import("@/state/store");

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
            sessionId: "sess_ps",
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
    turns: {},
    streaming: { ps: true, c1: true },
    stats: {},
    threadErrors: {},
    modelSelecting: {},
    pendingPermissions: {},
    drafts: {},
  });
}

beforeEach(() => {
  abort.mockReset();
  abort.mockResolvedValue();
  seed();
});

test("stopping the parent stops the running child and drops its request mapping", async () => {
  recordSubagentRequest("c1", {
    parentThreadId: "ps",
    parentSessionId: "sess_ps",
    requestId: "req1",
  });

  await useSessionStore.getState().stopStreaming("ps");

  // Both the parent's and the child's abort were requested.
  expect(abort).toHaveBeenCalledWith("sess_ps");
  expect(abort).toHaveBeenCalledWith("sess_c1");

  // The mapping is dropped so a late child `done` cannot answer a dead request.
  expect(takeSubagentRequest("c1")).toBeUndefined();
});

test("a parent with no live child requests is unaffected (no extra abort calls)", async () => {
  await useSessionStore.getState().stopStreaming("ps");

  expect(abort).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledWith("sess_ps");
});
