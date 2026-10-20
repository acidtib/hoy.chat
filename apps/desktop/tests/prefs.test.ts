import { afterEach, describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { usePrefsStore, PREFS_DEFAULTS, migratePrefs } = await import("@/state/prefs");
const { useSessionStore } = await import("@/state/store");

afterEach(() => {
  usePrefsStore.getState().reset();
});

describe("usePrefsStore", () => {
  test("ships the documented defaults", () => {
    expect(PREFS_DEFAULTS).toEqual({
      theme: "system",
      onboardingCompleted: false,
      sendOnEnter: true,
      showReasoning: false,
      expandEditTools: false,
      expandShellTools: true,
      defaultProjectDir: "",
      autoOpenSpawnedThreads: false,
      requireSubagentApproval: false,
      maxConcurrentAgents: 4,
      keepAwakeWhileStreaming: true,
      autoCompaction: true,
      sidebarCollapsed: false,
      autoTitles: true,
      preferredModel: null,
      disabledModels: [],
    });
  });

  test("setPref updates a single field", () => {
    usePrefsStore.getState().setPref("sendOnEnter", false);
    expect(usePrefsStore.getState().sendOnEnter).toBe(false);
    usePrefsStore.getState().setPref("defaultProjectDir", "/home/u/code");
    expect(usePrefsStore.getState().defaultProjectDir).toBe("/home/u/code");
    usePrefsStore.getState().setPref("theme", "system");
    expect(usePrefsStore.getState().theme).toBe("system");
    // Unrelated fields are untouched.
    expect(usePrefsStore.getState().showReasoning).toBe(false);
  });

  test("reset restores defaults", () => {
    usePrefsStore.getState().setPref("sendOnEnter", false);
    usePrefsStore.getState().reset();
    expect(usePrefsStore.getState().sendOnEnter).toBe(true);
  });
});

describe("migratePrefs", () => {
  test("v0 carries the old expand prefs onto the timeline part prefs", () => {
    expect(migratePrefs({ expandReasoning: true, expandToolDetails: true, theme: "dark" }, 0)).toEqual({
      showReasoning: true,
      expandEditTools: true,
      theme: "dark",
    });
  });

  test("v1 state passes through", () => {
    expect(migratePrefs({ showReasoning: true }, 1)).toEqual({ showReasoning: true });
  });
});

describe("closing a tab never stops work (HOY-372)", () => {
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

  test("a streaming thread's tab is dismissed and the thread keeps running", () => {
    seed({ t1: true });
    useSessionStore.getState().requestPanelClose("t1");
    const st = useSessionStore.getState();
    expect(st.panels.map((p) => p.id)).toEqual(["t2"]);
    expect(st.streaming.t1).toBe(true);
    expect(st.pendingTeardown).toBeNull();
  });

  test("an idle thread's tab closes with no dialog", () => {
    seed({});
    useSessionStore.getState().requestPanelClose("t1");
    expect(useSessionStore.getState().panels.map((p) => p.id)).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("archiving a streaming thread still asks first", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("archive", "t1");
    expect(useSessionStore.getState().pendingTeardown).toEqual({ action: "archive", threadId: "t1" });
  });
});
