import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PermissionRequest, Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// Named mocks these tests assert against; the shared helper fills in the rest
// of the ipc surface the store needs at import time.
const setPermissionMode =
  mock<(sessionId: string, mode: string) => Promise<void>>();
const respondPermission =
  mock<
    (
      sessionId: string,
      requestId: string,
      answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ) => Promise<void>
  >();
const closeSession = mock<(sessionId: string) => Promise<void>>();

mockIpcModule({ setPermissionMode, respondPermission, closeSession });

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
    panels: [{ id: "t1", width: 600 }],
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    modelSelecting: {},
    pendingPermissions: {},
    drafts: {},
  });
}

function thread(): Thread {
  return useSessionStore.getState().projects[0].threads[0];
}

function request(id: string): PermissionRequest {
  return {
    requestId: id,
    method: "select",
    title: "bash: cargo test",
    options: ["Allow", "Allow for this session", "Deny"],
  };
}

beforeEach(() => {
  setPermissionMode.mockReset();
  respondPermission.mockReset();
  closeSession.mockReset();
});

describe("setPermissionMode", () => {
  test("live session: /hoy_mode goes to the thread's own sessionId and the thread records the mode", async () => {
    seed({ sessionId: "sess_live" });
    setPermissionMode.mockResolvedValue();

    await useSessionStore.getState().setPermissionMode("t1", "plan");

    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith("sess_live", "plan");
    expect(thread().permissionMode).toBe("plan");
  });

  test("no session: defers without an RPC; the mode is recorded on the thread", async () => {
    seed({ sessionId: null });

    await useSessionStore.getState().setPermissionMode("t1", "autonomous");

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(thread().permissionMode).toBe("autonomous");
  });

  test("rejection reverts the optimistic mode and lands in threadErrors", async () => {
    seed({ sessionId: "sess_live", permissionMode: "acceptEdits" });
    setPermissionMode.mockRejectedValue(new Error("sidecar gone"));

    await useSessionStore.getState().setPermissionMode("t1", "plan");

    expect(thread().permissionMode).toBe("acceptEdits");
    expect(useSessionStore.getState().threadErrors["t1"]).toContain(
      "sidecar gone",
    );
  });

  test("re-selecting the current mode is a no-op", async () => {
    seed({ sessionId: "sess_live", permissionMode: "plan" });

    await useSessionStore.getState().setPermissionMode("t1", "plan");

    expect(setPermissionMode).not.toHaveBeenCalled();
  });
});

describe("answerPermission", () => {
  test("answers via the thread's sessionId and removes the card", async () => {
    seed({ sessionId: "sess_live" });
    useSessionStore.setState({
      pendingPermissions: { t1: [request("r1"), request("r2")] },
    });
    respondPermission.mockResolvedValue();

    await useSessionStore
      .getState()
      .answerPermission("t1", "r1", { value: "Allow" });

    expect(respondPermission).toHaveBeenCalledWith("sess_live", "r1", {
      value: "Allow",
    });
    expect(
      useSessionStore.getState().pendingPermissions["t1"].map((r) => r.requestId),
    ).toEqual(["r2"]);
  });

  test("a failed answer surfaces in threadErrors and the card stays removed", async () => {
    seed({ sessionId: "sess_live" });
    useSessionStore.setState({ pendingPermissions: { t1: [request("r1")] } });
    respondPermission.mockRejectedValue(new Error("write failed"));

    await useSessionStore
      .getState()
      .answerPermission("t1", "r1", { cancelled: true });

    expect(useSessionStore.getState().pendingPermissions["t1"]).toEqual([]);
    expect(useSessionStore.getState().threadErrors["t1"]).toContain(
      "write failed",
    );
  });
});

describe("pending card lifecycle", () => {
  test("closePanel drops the thread's pending cards with the rest of its live state", () => {
    seed({ sessionId: "sess_live", sessionFile: "/tmp/s.jsonl" });
    useSessionStore.setState({ pendingPermissions: { t1: [request("r1")] } });

    useSessionStore.getState().closePanel("t1");

    expect(useSessionStore.getState().pendingPermissions["t1"]).toBeUndefined();
  });
});
