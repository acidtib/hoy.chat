import { beforeEach, describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [],
    panels: [],
    bodyWidth: 1200,
    activeThreadId: null,
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

beforeEach(seed);

describe("addProject seeds a starter thread (HOY-226)", () => {
  test("a new project gets one thread and opens it", () => {
    useSessionStore.getState().addProject("/tmp/newproj");
    const project = useSessionStore.getState().projects.at(-1)!;
    expect(project.path).toBe("/tmp/newproj");
    expect(project.threads).toHaveLength(1);
    expect(project.threads[0].title).toBe("New thread");
    // The starter thread is opened (panel + focus request).
    const openId = project.threads[0].id;
    expect(useSessionStore.getState().panels.map((p) => p.id)).toContain(openId);
    expect(useSessionStore.getState().focusRequest?.threadId).toBe(openId);
  });

  test("re-adding the same path does not duplicate the project or add a thread", () => {
    useSessionStore.getState().addProject("/tmp/dup");
    const firstThreadId =
      useSessionStore.getState().projects[0].threads[0].id;

    useSessionStore.getState().addProject("/tmp/dup");
    const projects = useSessionStore.getState().projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].threads).toHaveLength(1);
    // Dedup surfaces the existing project's most recent thread.
    expect(useSessionStore.getState().focusRequest?.threadId).toBe(firstThreadId);
  });
});
