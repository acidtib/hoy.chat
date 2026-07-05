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
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
    notices: {},
    sessionTree: {},
    rightDock: {},
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
  test("toggleRightDock opens the view and primes the tree", async () => {
    useSessionStore.getState().toggleRightDock("t1", "tree");
    expect(useSessionStore.getState().rightDock.t1).toBe("tree");
    // refreshSessionTree fired; let its microtask settle, then the slice is set.
    await Promise.resolve();
    await Promise.resolve();
    expect(getTree).toHaveBeenCalledWith("sess_live");
    expect(useSessionStore.getState().sessionTree.t1).toEqual(TREE);
  });

  test("toggling the same view again closes it and stops observing the tree", () => {
    useSessionStore.setState({ rightDock: { t1: "tree" }, sessionTree: { t1: TREE } });
    useSessionStore.getState().toggleRightDock("t1", "tree");
    expect(useSessionStore.getState().rightDock.t1).toBeUndefined();
    expect(useSessionStore.getState().sessionTree.t1).toBeUndefined();
  });

  test("closeRightDock drops both the dock and the observed tree", () => {
    useSessionStore.setState({ rightDock: { t1: "tree" }, sessionTree: { t1: TREE } });
    useSessionStore.getState().closeRightDock("t1");
    expect(useSessionStore.getState().rightDock.t1).toBeUndefined();
    expect(useSessionStore.getState().sessionTree.t1).toBeUndefined();
  });

  test("closing the panel also closes its dock", () => {
    useSessionStore.setState({ rightDock: { t1: "tree" } });
    useSessionStore.getState().closePanel("t1");
    expect(useSessionStore.getState().rightDock.t1).toBeUndefined();
  });
});

describe("submitPrompt /tree interception (HOY-280)", () => {
  test("bare /tree toggles the dock and never reaches Pi", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/tree");
    expect(useSessionStore.getState().rightDock.t1).toBe("tree");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useSessionStore.getState().turns["t1"]).toBeUndefined();
  });

  test("/treeish and /tree with args fall through to Pi unchanged", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/treeish");
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().rightDock.t1).toBeUndefined();
  });
});

describe("branchFromEntry seam (HOY-280 -> HOY-283)", () => {
  test("surfaces an honest notice until the fork action lands", () => {
    useSessionStore.getState().branchFromEntry("t1", "entry-123");
    const notices = useSessionStore.getState().notices.t1 ?? [];
    expect(notices.length).toBe(1);
    expect(notices[0].message).toMatch(/HOY-283/);
  });
});
