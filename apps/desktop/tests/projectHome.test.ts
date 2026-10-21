import { beforeEach, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

const loadWorkspace = mock(async () => ({
  activeProjectId: "p1",
  projects: [{ id: "p1", name: "hoy", path: "/tmp/hoy", threads: [] }],
}));
mockIpcModule({ loadWorkspace });

const { useSessionStore } = await import("@/state/store");

beforeEach(() => {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "hoy",
        path: "/tmp/hoy",
        threads: [
          { id: "t1", title: "a", updatedAt: 0, sessionId: "live" },
          { id: "t2", title: "b", updatedAt: 0, sessionId: "live" },
        ],
      },
    ],
    panels: [],
    activeThreadId: null,
    activeProjectId: null,
    bodyView: "panels",
    projectView: "fleet",
  });
});

test("openProject makes the project active and shows its home on the view", () => {
  useSessionStore.getState().openProject("p1", "agents");
  const s = useSessionStore.getState();
  expect(s.activeProjectId).toBe("p1");
  expect(s.bodyView).toBe("project");
  expect(s.projectView).toBe("agents");
  useSessionStore.getState().openProject("p1");
  expect(useSessionStore.getState().projectView).toBe("fleet");
});

test("opening a thread leaves the project home; a background open stays", () => {
  useSessionStore.getState().openProject("p1");
  useSessionStore.getState().openThread("t1");
  expect(useSessionStore.getState().bodyView).toBe("panels");

  useSessionStore.getState().openProject("p1");
  useSessionStore.getState().openThread("t2", { background: true });
  const s = useSessionStore.getState();
  expect(s.bodyView).toBe("project");
  expect(s.panels.map((p) => p.id)).toContain("t2");
});

test("boot restores the last project's home", async () => {
  await useSessionStore.getState().initWorkspace();
  const s = useSessionStore.getState();
  expect(s.activeProjectId).toBe("p1");
  expect(s.bodyView).toBe("project");
  expect(s.projectView).toBe("fleet");
});

test("closing the last thread tab returns to the project home it came from", () => {
  const s = useSessionStore.getState();
  s.openProject("p1", "fleet");
  s.openThread("t1");
  s.openThread("t2");
  s.closePanel("t1");
  expect(useSessionStore.getState().bodyView).toBe("panels");
  useSessionStore.getState().closePanel("t2");
  const after = useSessionStore.getState();
  expect(after.bodyView).toBe("project");
  expect(after.projectView).toBe("fleet");
});

test("closing the last tab returns to whichever project view was open", () => {
  useSessionStore.getState().openProject("p1", "threads");
  useSessionStore.getState().openThread("t1");
  useSessionStore.getState().closePanel("t1");
  const s = useSessionStore.getState();
  expect(s.bodyView).toBe("project");
  expect(s.projectView).toBe("threads");
});
