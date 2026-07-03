import { afterEach, describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { usePrefsStore, PREFS_DEFAULTS } = await import("@/state/prefs");
const { useSessionStore } = await import("@/state/store");

afterEach(() => {
  usePrefsStore.getState().reset();
});

describe("usePrefsStore", () => {
  test("ships the documented defaults", () => {
    expect(PREFS_DEFAULTS).toEqual({
      sendOnEnter: true,
      expandReasoning: false,
      expandToolDetails: false,
      confirmCloseStreaming: true,
      defaultProjectDir: "",
      autoOpenSpawnedThreads: false,
      requireSubagentApproval: false,
      maxConcurrentAgents: 4,
      keepAwakeWhileStreaming: true,
    });
  });

  test("setPref updates a single field", () => {
    usePrefsStore.getState().setPref("sendOnEnter", false);
    expect(usePrefsStore.getState().sendOnEnter).toBe(false);
    usePrefsStore.getState().setPref("defaultProjectDir", "/home/u/code");
    expect(usePrefsStore.getState().defaultProjectDir).toBe("/home/u/code");
    // Unrelated fields are untouched.
    expect(usePrefsStore.getState().expandReasoning).toBe(false);
  });

  test("reset restores defaults", () => {
    usePrefsStore.getState().setPref("confirmCloseStreaming", false);
    usePrefsStore.getState().reset();
    expect(usePrefsStore.getState().confirmCloseStreaming).toBe(true);
  });
});

describe("confirmCloseStreaming gates the teardown dialog", () => {
  function seed(streaming: Record<string, boolean>) {
    useSessionStore.setState({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t1",
              title: "A",
              updatedAt: 1,
              sessionId: null,
              sessionFile: "/tmp/a.jsonl",
            },
            {
              id: "t2",
              title: "B",
              updatedAt: 2,
              sessionId: null,
              sessionFile: "/tmp/b.jsonl",
            },
          ],
        },
      ],
      panels: [
        { id: "t1", width: 600 },
        { id: "t2", width: 600 },
      ],
      bodyWidth: 1200,
      activeThreadId: "t1",
      expandedThreadId: null,
      focusRequest: null,
      pendingTeardown: null,
      drafts: {},
      turns: {},
      stats: {},
      streaming,
      threadErrors: {},
      modelSelecting: {},
    });
  }

  test("off: a streaming thread closes immediately, no dialog", () => {
    usePrefsStore.getState().setPref("confirmCloseStreaming", false);
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(useSessionStore.getState().panels.map((p) => p.id)).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("on (default): a streaming thread parks a pending teardown", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(useSessionStore.getState().pendingTeardown).toEqual({
      action: "close",
      threadId: "t1",
    });
  });
});
