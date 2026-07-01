import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed(streaming: Record<string, boolean> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "A", updatedAt: 1, sessionId: null, sessionFile: "/tmp/a.jsonl" },
          { id: "t2", title: "B", updatedAt: 2, sessionId: null, sessionFile: "/tmp/b.jsonl" },
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

function panelIds(): string[] {
  return useSessionStore.getState().panels.map((p) => p.id);
}

function thread(id: string) {
  return useSessionStore
    .getState()
    .projects[0]?.threads.find((t) => t.id === id);
}

describe("requestTeardown on idle threads", () => {
  test("close runs immediately with nothing pending", () => {
    seed();
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(panelIds()).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("archive runs immediately", () => {
    seed();
    useSessionStore.getState().requestTeardown("archive", "t1");
    expect(thread("t1")?.archived).toBe(true);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("delete runs immediately", () => {
    seed();
    useSessionStore.getState().requestTeardown("delete", "t1");
    expect(thread("t1")).toBeUndefined();
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });
});

describe("requestTeardown on streaming threads", () => {
  test("parks the action and tears nothing down", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    expect(panelIds()).toEqual(["t1", "t2"]);
    expect(useSessionStore.getState().pendingTeardown).toEqual({
      action: "close",
      threadId: "t1",
    });
  });

  test("cancel keeps the panel open and the stream flagged", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    useSessionStore.getState().cancelTeardown();
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
    expect(panelIds()).toEqual(["t1", "t2"]);
    expect(useSessionStore.getState().streaming.t1).toBe(true);
  });

  test("confirm close matches the direct action's end state", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("close", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(panelIds()).toEqual(["t2"]);
    expect(useSessionStore.getState().pendingTeardown).toBeNull();
  });

  test("confirm archive archives and closes the panel", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("archive", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(thread("t1")?.archived).toBe(true);
    expect(panelIds()).toEqual(["t2"]);
  });

  test("confirm delete removes the thread", () => {
    seed({ t1: true });
    useSessionStore.getState().requestTeardown("delete", "t1");
    useSessionStore.getState().confirmTeardown();
    expect(thread("t1")).toBeUndefined();
    expect(panelIds()).toEqual(["t2"]);
  });

  test("confirm with nothing pending is a no-op", () => {
    seed();
    useSessionStore.getState().confirmTeardown();
    expect(panelIds()).toEqual(["t1", "t2"]);
  });
});
