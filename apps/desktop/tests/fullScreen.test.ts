import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "A", updatedAt: 1, sessionId: null, sessionFile: "/tmp/a.jsonl" },
          { id: "t2", title: "B", updatedAt: 2, sessionId: null, sessionFile: "/tmp/b.jsonl" },
          { id: "t3", title: "C", updatedAt: 3, sessionId: null, sessionFile: "/tmp/c.jsonl" },
        ],
      },
    ],
    panels: [
      { id: "t1", width: 400 },
      { id: "t2", width: 500 },
      { id: "t3", width: 300 },
    ],
    bodyWidth: 1200,
    activeThreadId: "t2",
    expandedThreadId: null,
    drafts: {},
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
  });
}

describe("toggleFullScreen", () => {
  test("sets and clears the expanded thread", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("panel widths are untouched through a full screen round trip", () => {
    seed();
    const before = useSessionStore.getState().panels.map((p) => p.width);
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().toggleFullScreen("t2");
    expect(useSessionStore.getState().panels.map((p) => p.width)).toEqual(
      before,
    );
  });
});

describe("full screen clears on lifecycle events", () => {
  test("closing the expanded thread clears it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().closePanel("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("closing another thread keeps it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });

  test("archiving the expanded thread clears it", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().archiveThread("t2");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
  });

  test("opening a different thread exits full screen", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().openThread("t3");
    expect(useSessionStore.getState().expandedThreadId).toBeNull();
    expect(useSessionStore.getState().activeThreadId).toBe("t3");
  });

  test("re-opening the expanded thread keeps full screen", () => {
    seed();
    useSessionStore.getState().toggleFullScreen("t2");
    useSessionStore.getState().openThread("t2");
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });
});
