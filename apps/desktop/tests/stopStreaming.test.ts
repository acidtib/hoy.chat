import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

const abort = mock<(sessionId: string) => Promise<void>>();

mockIpcModule({ abort });

const { useSessionStore } = await import("@/state/store");

function seed(thread: Partial<Thread>, streaming: boolean) {
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
    streaming: { t1: streaming },
    threadErrors: {},
  });
}

beforeEach(() => {
  abort.mockReset();
});

describe("stopStreaming", () => {
  test("aborts via the thread's own sessionId", async () => {
    seed({ sessionId: "sess_live" }, true);
    abort.mockResolvedValue();

    await useSessionStore.getState().stopStreaming("t1");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("sess_live");
  });

  test("no-op when the thread is not streaming", async () => {
    seed({ sessionId: "sess_live" }, false);

    await useSessionStore.getState().stopStreaming("t1");

    expect(abort).not.toHaveBeenCalled();
  });

  test("no-op when the thread has no live session", async () => {
    seed({ sessionId: null }, true);

    await useSessionStore.getState().stopStreaming("t1");

    expect(abort).not.toHaveBeenCalled();
  });

  test("a failed abort surfaces in threadErrors", async () => {
    seed({ sessionId: "sess_live" }, true);
    abort.mockRejectedValue(new Error("sidecar gone"));

    await useSessionStore.getState().stopStreaming("t1");

    expect(useSessionStore.getState().threadErrors["t1"]).toContain(
      "sidecar gone",
    );
  });
});
