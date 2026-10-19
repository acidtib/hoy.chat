import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { usePrefsStore } = await import("@/state/prefs");
const { useSessionStore, groupTabs } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: ["t1", "t2", "t3"].map((id) => ({
          id,
          title: "Thread",
          updatedAt: 0,
          sessionId: "live",
        })),
      },
    ],
    panels: [{ id: "t1", width: 800 }],
    bodyWidth: 800,
    activeThreadId: "t1",
    focusRequest: null,
  });
}

afterEach(() => {
  usePrefsStore.getState().reset();
});

describe("openThread background", () => {
  test("adds a tab without switching to it", () => {
    seed();
    useSessionStore.getState().openThread("t2", { background: true });
    const s = useSessionStore.getState();
    expect(s.panels.map((p) => p.id)).toEqual(["t1", "t2"]);
    expect(s.activeThreadId).toBe("t1");
    expect(s.focusRequest).toBeNull();
  });
});

describe("tabs mode splits", () => {
  test("a new thread opens as its own full width tab", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    const s = useSessionStore.getState();
    expect(groupTabs(s.panels).map((t) => t.panels.map((p) => p.id))).toEqual([
      ["t1"],
      ["t2"],
    ]);
    expect(s.panels.find((p) => p.id === "t2")?.width).toBe(800);
    expect(s.activeThreadId).toBe("t2");
  });

  test("split opens beside the active thread and shares the tab width", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().openThread("t3", { split: true });
    const s = useSessionStore.getState();
    expect(s.panels.map((p) => p.id)).toEqual(["t1", "t3", "t2"]);
    expect(groupTabs(s.panels).map((t) => t.panels.map((p) => p.id))).toEqual([
      ["t1", "t3"],
      ["t2"],
    ]);
    expect(s.panels.find((p) => p.id === "t2")?.width).toBe(800);
  });

  test("closing a split focuses its tab sibling and refits the tab", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    useSessionStore.getState().openThread("t1");
    useSessionStore.getState().openThread("t3", { split: true });
    useSessionStore.getState().dismissPanel("t3");
    const s = useSessionStore.getState();
    expect(s.activeThreadId).toBe("t1");
    expect(s.panels.map((p) => [p.id, p.width])).toEqual([
      ["t1", 800],
      ["t2", 800],
    ]);
  });

  test("dragging never resizes across a tab boundary", () => {
    seed();
    useSessionStore.getState().openThread("t2");
    useSessionStore.getState().resizePanelEdge(0, -100);
    expect(useSessionStore.getState().panels.map((p) => p.width)).toEqual([
      800, 800,
    ]);
  });
});
