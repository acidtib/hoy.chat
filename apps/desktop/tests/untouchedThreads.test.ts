import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Turn, Workspace } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// Named mocks these tests assert against; the shared helper fills in the rest
// of the ipc surface the store needs at import time.
const saveWorkspace = mock<(ws: unknown) => Promise<void>>();
const loadWorkspace = mock<() => Promise<Workspace>>();

mockIpcModule({ saveWorkspace, loadWorkspace });

const { useSessionStore } = await import("@/state/store");

const USER_TURN: Turn[] = [{ role: "user", text: "hi" }];

function seed(turns: Record<string, Turn[]> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          // Untouched: never prompted, never renamed.
          { id: "t_untouched", title: "New thread", updatedAt: 1, sessionId: null },
          // Renamed but never prompted: user work, kept.
          {
            id: "t_renamed",
            title: "research ideas",
            updatedAt: 2,
            sessionId: null,
            renamed: true,
          },
          // Prompted: has a transcript on disk, kept.
          {
            id: "t_sent",
            title: "New thread",
            updatedAt: 3,
            sessionId: null,
            sessionFile: "/tmp/s.jsonl",
          },
        ],
      },
    ],
    panels: [],
    turns,
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

describe("persistProjects untouched filter", () => {
  test("payload drops untouched threads, keeps renamed-but-unsent and sent ones", async () => {
    loadWorkspace.mockResolvedValue({ projects: [] });
    saveWorkspace.mockResolvedValue(undefined);
    await useSessionStore.getState().initWorkspace();
    seed();

    // The debounced autosave fires 300ms after a projects change.
    await new Promise((r) => setTimeout(r, 400));

    expect(saveWorkspace).toHaveBeenCalled();
    const payload = saveWorkspace.mock.calls.at(-1)?.[0] as Workspace;
    const ids = payload.projects[0].threads.map((t) => t.id);
    expect(ids).toEqual(["t_renamed", "t_sent"]);
    // The flag itself persists, or the renamed thread reads as untouched after
    // a restart and gets dropped on the next save.
    expect(payload.projects[0].threads[0].renamed).toBe(true);
  });

  test("a thread with in-memory turns but no sessionFile yet is kept", async () => {
    loadWorkspace.mockResolvedValue({ projects: [] });
    saveWorkspace.mockResolvedValue(undefined);
    await useSessionStore.getState().initWorkspace();
    seed({ t_untouched: USER_TURN });

    await new Promise((r) => setTimeout(r, 400));

    const payload = saveWorkspace.mock.calls.at(-1)?.[0] as Workspace;
    const ids = payload.projects[0].threads.map((t) => t.id);
    expect(ids).toContain("t_untouched");
  });
});

describe("initWorkspace legacy backfill", () => {
  test("pre-flag threads with a custom title and no transcript get renamed: true", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            // Renamed before the flag existed: must not be dropped as untouched.
            { id: "t_legacy", title: "my notes", updatedAt: 1 },
            // Default title, no transcript: genuinely untouched debris.
            { id: "t_empty", title: "New thread", updatedAt: 2 },
            // Auto-titled by submitPrompt: sessionFile already protects it,
            // the flag stays unset.
            {
              id: "t_auto",
              title: "first prompt text",
              updatedAt: 3,
              sessionFile: "/tmp/s.jsonl",
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const threads = useSessionStore.getState().projects[0].threads;
    expect(threads.find((t) => t.id === "t_legacy")?.renamed).toBe(true);
    expect(threads.find((t) => t.id === "t_empty")?.renamed).toBeFalsy();
    expect(threads.find((t) => t.id === "t_auto")?.renamed).toBeFalsy();
  });
});

describe("renameThread sets the renamed flag", () => {
  test("any rename marks the thread, including the literal default title", () => {
    seed();
    useSessionStore.getState().renameThread("t_untouched", "New thread");
    const thread = useSessionStore
      .getState()
      .projects[0].threads.find((t) => t.id === "t_untouched");
    expect(thread?.renamed).toBe(true);
  });
});

describe("closePanel discards untouched threads", () => {
  test("closing an untouched thread's panel removes it from the projects tree", () => {
    seed();
    useSessionStore.setState({
      panels: [{ id: "t_untouched", width: 600 }],
      activeThreadId: "t_untouched",
    });

    useSessionStore.getState().closePanel("t_untouched");

    expect(threadIds()).toEqual(["t_renamed", "t_sent"]);
  });

  test("closing a touched thread's panel keeps the thread", () => {
    seed();
    useSessionStore.setState({ panels: [{ id: "t_sent", width: 600 }] });

    useSessionStore.getState().closePanel("t_sent");

    expect(threadIds()).toContain("t_sent");
  });

  test("a thread with in-flight turns survives its panel closing", () => {
    seed({ t_untouched: USER_TURN });
    useSessionStore.setState({ panels: [{ id: "t_untouched", width: 600 }] });

    useSessionStore.getState().closePanel("t_untouched");

    expect(threadIds()).toContain("t_untouched");
  });
});

describe("archiveThread on untouched threads", () => {
  test("archiving an untouched thread deletes it instead", () => {
    seed();

    useSessionStore.getState().archiveThread("t_untouched");

    expect(threadIds()).toEqual(["t_renamed", "t_sent"]);
  });

  test("archiving a touched thread archives it normally", () => {
    seed();

    useSessionStore.getState().archiveThread("t_sent");

    const thread = useSessionStore
      .getState()
      .projects[0].threads.find((t) => t.id === "t_sent");
    expect(thread?.archived).toBe(true);
  });
});
