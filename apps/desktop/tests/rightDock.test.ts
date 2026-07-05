import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionTree } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// HOY-280: the right-side dock host + /tree intercept + branch affordance seam.
const sendPrompt =
  mock<(sessionId: string, message: string, channel: unknown) => Promise<void>>();
const getTree = mock<(s: string) => Promise<SessionTree>>();
const getState = mock<(s: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, getTree, getState });

const { useSessionStore } = await import("@/state/store");

const TREE: SessionTree = { tree: [], leafId: null };

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [{ id: "t1", title: "T", updatedAt: 0, sessionId: "sess_live" }],
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
    notices: {},
    sessionTree: {},
    rightDock: null,
  });
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  getTree.mockReset();
  getTree.mockResolvedValue(TREE);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  seed();
});

describe("right dock (HOY-280)", () => {
  test("toggleRightDock opens the view and primes the active thread's tree", async () => {
    useSessionStore.getState().toggleRightDock("tree");
    expect(useSessionStore.getState().rightDock).toBe("tree");
    // refreshSessionTree fired for the active thread; settle its microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(getTree).toHaveBeenCalledWith("sess_live");
    expect(useSessionStore.getState().sessionTree.t1).toEqual(TREE);
  });

  test("toggling the same view again closes the dock", () => {
    useSessionStore.setState({ rightDock: "tree" });
    useSessionStore.getState().toggleRightDock("tree");
    expect(useSessionStore.getState().rightDock).toBeNull();
  });

  test("closeRightDock closes the dock", () => {
    useSessionStore.setState({ rightDock: "tree" });
    useSessionStore.getState().closeRightDock();
    expect(useSessionStore.getState().rightDock).toBeNull();
  });

  test("the global dock survives closing a panel", () => {
    useSessionStore.setState({ rightDock: "tree" });
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().rightDock).toBe("tree");
  });
});

describe("submitPrompt /tree interception (HOY-280)", () => {
  test("bare /tree toggles the dock and never reaches Pi", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/tree");
    expect(useSessionStore.getState().rightDock).toBe("tree");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useSessionStore.getState().turns["t1"]).toBeUndefined();
  });

  test("/treeish and /tree with args fall through to Pi unchanged", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/treeish");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().rightDock).toBeNull();
  });
});

