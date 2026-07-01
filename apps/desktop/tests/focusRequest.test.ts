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
        ],
      },
    ],
    panels: [{ id: "t1", width: 600 }],
    bodyWidth: 1200,
    activeThreadId: "t1",
    expandedThreadId: null,
    focusRequest: null,
    drafts: {},
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
  });
}

describe("openThread sets focusRequest", () => {
  test("already-open thread: request carries the threadId", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    expect(useSessionStore.getState().focusRequest).toEqual({
      threadId: "t1",
      nonce: 1,
    });
  });

  test("repeat clicks bump the nonce", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().openThread("t1");
    expect(useSessionStore.getState().focusRequest?.nonce).toBe(2);
  });

  test("fresh-open thread also gets a request", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    expect(useSessionStore.getState().focusRequest?.threadId).toBe("t2");
    expect(useSessionStore.getState().panels.map((p) => p.id)).toContain("t2");
  });

  test("addThread leaves a request for the new thread", () => {
    seed();
    const id = useSessionStore.getState().addThread("p1");
    expect(useSessionStore.getState().focusRequest?.threadId).toBe(id);
  });
});

describe("focusPanel", () => {
  test("sets activeThreadId without touching focusRequest or full screen", () => {
    seed();
    useSessionStore.setState({
      panels: [
        { id: "t1", width: 600 },
        { id: "t2", width: 600 },
      ],
      expandedThreadId: "t2",
    });
    useSessionStore.getState().focusPanel("t2");
    expect(useSessionStore.getState().activeThreadId).toBe("t2");
    expect(useSessionStore.getState().focusRequest).toBeNull();
    expect(useSessionStore.getState().expandedThreadId).toBe("t2");
  });
});

describe("stale requests are cleared", () => {
  test("closing the requested thread clears the request", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().focusRequest).toBeNull();
  });

  test("toggleFullScreen drops any pending request", () => {
    seed();
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().toggleFullScreen("t1");
    expect(useSessionStore.getState().focusRequest).toBeNull();
  });
});
