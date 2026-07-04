import { beforeEach, expect, test, mock } from "bun:test";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [],
    panels: [],
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

test("startThread creates a thread in the project, records the picks, and submits", () => {
  useSessionStore.getState().addProject("/tmp/p");
  const projId = useSessionStore.getState().projects[0].id;
  const before = useSessionStore.getState().projects[0].threads.length;

  // Isolate startThread's orchestration from the real send path.
  const submitPrompt = mock(async () => {});
  useSessionStore.setState({ submitPrompt });

  useSessionStore.getState().startThread(projId, "do the thing", {
    model: { provider: "anthropic", id: "opus" },
    permissionMode: "acceptEdits",
    thinkingLevel: "high",
  });

  const threads = useSessionStore.getState().projects[0].threads;
  expect(threads.length).toBe(before + 1);
  const t = threads[0]; // addThread prepends
  expect(t.model).toEqual({ provider: "anthropic", id: "opus" });
  expect(t.permissionMode).toBe("acceptEdits");
  expect(t.thinkingLevel).toBe("high");
  expect(submitPrompt).toHaveBeenCalledTimes(1);
  expect(submitPrompt.mock.calls[0][0]).toBe(t.id);
  expect(submitPrompt.mock.calls[0][1]).toBe("do the thing");
});

test("startThread with no model still records permission/thinking and submits", () => {
  useSessionStore.getState().addProject("/tmp/q");
  const projId = useSessionStore.getState().projects[0].id;
  const submitPrompt = mock(async () => {});
  useSessionStore.setState({ submitPrompt });

  useSessionStore.getState().startThread(projId, "hi", {
    model: null,
    permissionMode: "plan",
    thinkingLevel: "high",
  });

  const t = useSessionStore.getState().projects[0].threads[0];
  expect(t.model).toBeUndefined(); // no model pick recorded
  expect(t.permissionMode).toBe("plan");
  expect(submitPrompt).toHaveBeenCalledTimes(1);
});
