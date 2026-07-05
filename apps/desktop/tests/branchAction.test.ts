import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ForkResult, SessionStats } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// HOY-283: branchFromEntry opens a sidecar on the source file, forks it, and
// surfaces the branch as a child thread seeded to that point.
const createSession = mock<(...a: unknown[]) => Promise<string>>();
const forkSession = mock<(s: string, e: string) => Promise<ForkResult>>();
const getSessionStats = mock<(s: string) => Promise<SessionStats>>();
const getMessages = mock<(s: string) => Promise<unknown[]>>();
const closeSession = mock<(s: string) => Promise<void>>();

mockIpcModule({ createSession, forkSession, getSessionStats, getMessages, closeSession });

const { useSessionStore } = await import("@/state/store");

function seed(sessionFile: string | undefined) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "Refactor auth", updatedAt: 0, sessionId: "sess_src", sessionFile },
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
    notices: {},
    drafts: {},
    sessionTree: {},
    rightDock: "tree",
  });
}

function childThread() {
  return useSessionStore
    .getState()
    .projects[0].threads.find((t) => t.id !== "t1");
}

beforeEach(() => {
  createSession.mockReset();
  createSession.mockResolvedValue("sess_branch");
  forkSession.mockReset();
  forkSession.mockResolvedValue({ text: "make it faster", cancelled: false });
  getSessionStats.mockReset();
  getSessionStats.mockResolvedValue({ sessionFile: "/s/branch.jsonl" } as SessionStats);
  getMessages.mockReset();
  getMessages.mockResolvedValue([{ role: "user", content: "make it faster" }]);
  closeSession.mockReset();
  closeSession.mockResolvedValue(undefined);
  seed("/s/source.jsonl");
});

describe("branchFromEntry (HOY-283)", () => {
  test("forks the source file into a new child thread seeded to the entry", async () => {
    await useSessionStore.getState().branchFromEntry("t1", "entry-9");

    // Opened a sidecar on the SOURCE file, then forked at the entry.
    expect(createSession.mock.calls[0][1]).toBe("/s/source.jsonl");
    expect(forkSession).toHaveBeenCalledWith("sess_branch", "entry-9");

    const child = childThread();
    expect(child).toBeDefined();
    expect(child!.parentThreadId).toBe("t1");
    expect(child!.sessionId).toBe("sess_branch");
    expect(child!.sessionFile).toBe("/s/branch.jsonl");
    expect(child!.title).toContain("Branch");
    // Source thread is intact.
    const src = useSessionStore.getState().projects[0].threads.find((t) => t.id === "t1");
    expect(src!.sessionId).toBe("sess_src");
    expect(src!.sessionFile).toBe("/s/source.jsonl");
  });

  test("opens the branch and prefills the composer with the forked message", async () => {
    await useSessionStore.getState().branchFromEntry("t1", "entry-9");
    const child = childThread()!;
    expect(useSessionStore.getState().activeThreadId).toBe(child.id);
    expect(useSessionStore.getState().panels.some((p) => p.id === child.id)).toBe(true);
    expect(useSessionStore.getState().drafts[child.id]).toBe("make it faster");
    // Transcript seeded from the branch.
    expect((useSessionStore.getState().turns[child.id] ?? []).length).toBe(1);
  });

  test("a cancelled fork tears down the sidecar and adds no thread", async () => {
    forkSession.mockResolvedValue({ cancelled: true });
    await useSessionStore.getState().branchFromEntry("t1", "entry-9");
    expect(closeSession).toHaveBeenCalledWith("sess_branch");
    expect(childThread()).toBeUndefined();
  });

  test("refuses to branch a thread with no saved session", async () => {
    seed(undefined);
    await useSessionStore.getState().branchFromEntry("t1", "entry-9");
    expect(createSession).not.toHaveBeenCalled();
    expect(childThread()).toBeUndefined();
  });

  test("refuses to branch while the source is streaming", async () => {
    useSessionStore.setState({ streaming: { t1: true } });
    await useSessionStore.getState().branchFromEntry("t1", "entry-9");
    expect(createSession).not.toHaveBeenCalled();
    expect(childThread()).toBeUndefined();
  });
});
