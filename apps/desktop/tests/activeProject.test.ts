import { beforeEach, describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "alpha",
        path: "/tmp/alpha",
        threads: [
          { id: "t1", title: "A", updatedAt: 1, sessionId: null },
          { id: "t2", title: "B", updatedAt: 2, sessionId: null },
        ],
      },
      {
        id: "p2",
        name: "beta",
        path: "/tmp/beta",
        threads: [{ id: "t3", title: "C", updatedAt: 3, sessionId: null }],
      },
    ],
    panels: [],
    activeThreadId: null,
    activeProjectId: null,
    bodyWidth: 1200,
    expandedThreadId: null,
    focusRequest: null,
    turns: {},
    drafts: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
  });
}

beforeEach(seed);

describe("activeProjectId (last worked-in project)", () => {
  test("openThread records the thread's project", () => {
    useSessionStore.getState().openThread("t3");
    expect(useSessionStore.getState().activeProjectId).toBe("p2");
    useSessionStore.getState().openThread("t1");
    expect(useSessionStore.getState().activeProjectId).toBe("p1");
  });

  test("focusPanel records the thread's project", () => {
    useSessionStore.getState().focusPanel("t3");
    expect(useSessionStore.getState().activeProjectId).toBe("p2");
  });

  test("setActiveProject sets it directly", () => {
    useSessionStore.getState().setActiveProject("p2");
    expect(useSessionStore.getState().activeProjectId).toBe("p2");
  });

  test("removeProject clears activeProjectId when it points at the removed one", () => {
    useSessionStore.getState().setActiveProject("p2");
    useSessionStore.getState().removeProject("p2");
    expect(useSessionStore.getState().activeProjectId).toBeNull();
  });

  test("removeProject keeps activeProjectId when a different project is removed", () => {
    useSessionStore.getState().setActiveProject("p1");
    useSessionStore.getState().removeProject("p2");
    expect(useSessionStore.getState().activeProjectId).toBe("p1");
  });

  test("addThread targets and records its project", () => {
    const id = useSessionStore.getState().addThread("p2");
    expect(useSessionStore.getState().activeProjectId).toBe("p2");
    // the new thread is prepended to p2 and opened
    const p2 = useSessionStore.getState().projects.find((p) => p.id === "p2");
    expect(p2?.threads[0]?.id).toBe(id);
  });
});
