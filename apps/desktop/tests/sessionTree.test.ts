import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionTree, Thread } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// HOY-279: the per-thread sessionTree store slice feeding the /tree navigator.
const getTree = mock<(sessionId: string) => Promise<SessionTree>>();

mockIpcModule({ getTree });

const { useSessionStore } = await import("@/state/store");

const TREE: SessionTree = {
  tree: [
    {
      entry: { type: "message", id: "e1", parentId: null, timestamp: "t0", message: {} },
      children: [],
    },
  ],
  leafId: "e1",
};

function seed(thread: Partial<Thread> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "Thread", updatedAt: 0, sessionId: "sess_live", ...thread },
        ],
      },
    ],
    panels: [{ id: "t1", width: 1 }],
    activeThreadId: "t1",
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
    pendingPermissions: {},
    notices: {},
    statuses: {},
    widgets: {},
    slashCommands: {},
    sessionTree: {},
    drafts: {},
  });
}

beforeEach(() => {
  getTree.mockReset();
  getTree.mockResolvedValue(TREE);
});

describe("refreshSessionTree (HOY-279)", () => {
  test("populates the thread's tree from get_tree on a live session", async () => {
    seed();
    await useSessionStore.getState().refreshSessionTree("t1");
    expect(getTree).toHaveBeenCalledWith("sess_live");
    expect(useSessionStore.getState().sessionTree.t1).toEqual(TREE);
  });

  test("is a no-op without a live session (never calls get_tree)", async () => {
    seed({ sessionId: undefined });
    await useSessionStore.getState().refreshSessionTree("t1");
    expect(getTree).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessionTree.t1).toBeUndefined();
  });

  test("leaves the prior tree in place when get_tree fails", async () => {
    seed();
    useSessionStore.setState({ sessionTree: { t1: TREE } });
    getTree.mockRejectedValue(new Error("no active session for get_tree"));
    await useSessionStore.getState().refreshSessionTree("t1");
    // Unchanged, not cleared to null.
    expect(useSessionStore.getState().sessionTree.t1).toEqual(TREE);
  });

  test("closing the panel drops the tree so a reopen re-fetches", () => {
    seed();
    useSessionStore.setState({ sessionTree: { t1: TREE } });
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().sessionTree.t1).toBeUndefined();
  });
});
