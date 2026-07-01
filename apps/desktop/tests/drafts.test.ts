import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread, Workspace } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

const saveWorkspace = mock<(ws: unknown) => Promise<void>>();
const loadWorkspace = mock<() => Promise<Workspace>>();

mockIpcModule({ saveWorkspace, loadWorkspace });

const { useSessionStore } = await import("@/state/store");

function seed(drafts: Record<string, string> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          // Untouched: never prompted, never renamed.
          { id: "t_untouched", title: "New thread", updatedAt: 1, sessionId: null },
          // Prompted: has a transcript on disk.
          {
            id: "t_sent",
            title: "New thread",
            updatedAt: 2,
            sessionId: null,
            sessionFile: "/tmp/s.jsonl",
          },
        ],
      },
    ],
    panels: [],
    drafts,
    turns: {},
    stats: {},
    streaming: {},
    threadErrors: {},
    modelSelecting: {},
    activeThreadId: null,
  });
}

function threadIds(): string[] {
  return useSessionStore.getState().projects[0]?.threads.map((t) => t.id) ?? [];
}

beforeEach(() => {
  saveWorkspace.mockReset();
  loadWorkspace.mockReset();
});

describe("drafts slice", () => {
  test("setDraft stores and overwrites the value", () => {
    seed();
    useSessionStore.getState().setDraft("t_sent", "hello");
    expect(useSessionStore.getState().drafts.t_sent).toBe("hello");
    useSessionStore.getState().setDraft("t_sent", "hello again");
    expect(useSessionStore.getState().drafts.t_sent).toBe("hello again");
  });

  test("draft survives closePanel", () => {
    seed({ t_sent: "unsent text" });
    useSessionStore.setState({
      panels: [{ id: "t_sent", width: 600 }],
      activeThreadId: "t_sent",
    });
    useSessionStore.getState().closePanel("t_sent");
    expect(useSessionStore.getState().drafts.t_sent).toBe("unsent text");
  });

  test("a draft-only thread is kept on closePanel", () => {
    seed({ t_untouched: "started typing" });
    useSessionStore.setState({
      panels: [{ id: "t_untouched", width: 600 }],
      activeThreadId: "t_untouched",
    });
    useSessionStore.getState().closePanel("t_untouched");
    expect(threadIds()).toContain("t_untouched");
  });

  test("a whitespace-only draft does not keep an untouched thread", () => {
    seed({ t_untouched: "   " });
    useSessionStore.setState({
      panels: [{ id: "t_untouched", width: 600 }],
      activeThreadId: "t_untouched",
    });
    useSessionStore.getState().closePanel("t_untouched");
    expect(threadIds()).not.toContain("t_untouched");
  });

  test("archiving a draft-only thread archives instead of deleting", () => {
    seed({ t_untouched: "started typing" });
    useSessionStore.getState().archiveThread("t_untouched");
    const thread = useSessionStore
      .getState()
      .projects[0].threads.find((t) => t.id === "t_untouched");
    expect(thread?.archived).toBe(true);
  });

  test("deleteThread drops the draft", () => {
    seed({ t_sent: "unsent" });
    useSessionStore.getState().deleteThread("t_sent");
    expect(useSessionStore.getState().drafts.t_sent).toBeUndefined();
  });
});

describe("draft persistence", () => {
  test("a draft change alone triggers autosave and the payload carries it", async () => {
    loadWorkspace.mockResolvedValue({ projects: [] });
    saveWorkspace.mockResolvedValue(undefined);
    await useSessionStore.getState().initWorkspace();
    seed();
    // Let the seed's own projects-change autosave drain first.
    await new Promise((r) => setTimeout(r, 400));
    saveWorkspace.mockClear();

    useSessionStore.getState().setDraft("t_sent", "persist me");
    await new Promise((r) => setTimeout(r, 400));

    expect(saveWorkspace).toHaveBeenCalled();
    const payload = saveWorkspace.mock.calls.at(-1)?.[0] as Workspace;
    const thread = payload.projects[0].threads.find((t) => t.id === "t_sent");
    expect(thread?.draft).toBe("persist me");
  });

  test("initWorkspace restores drafts into the slice and off the threads", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: null,
          threads: [
            {
              id: "t1",
              title: "T",
              updatedAt: 1,
              sessionFile: "/tmp/s.jsonl",
              draft: "restored",
            } as Thread,
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    expect(useSessionStore.getState().drafts.t1).toBe("restored");
    expect(
      useSessionStore.getState().projects[0].threads[0].draft,
    ).toBeUndefined();
  });
});
