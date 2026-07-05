import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CloneResult, ForkMessages, SessionStats } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// HOY-284: /clone duplicates the current thread into a new child thread; /fork
// opens a get_fork_messages-backed picker whose pick branches a new thread.
const createSession = mock<(...a: unknown[]) => Promise<string>>();
const cloneSession = mock<(s: string) => Promise<CloneResult>>();
const forkSession = mock<(s: string, e: string) => Promise<unknown>>();
const getForkMessages = mock<(s: string) => Promise<ForkMessages>>();
const getSessionStats = mock<(s: string) => Promise<SessionStats>>();
const getMessages = mock<(s: string) => Promise<unknown[]>>();
const closeSession = mock<(s: string) => Promise<void>>();

mockIpcModule({
  createSession,
  cloneSession,
  forkSession,
  getForkMessages,
  getSessionStats,
  getMessages,
  closeSession,
});

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          {
            id: "t1",
            title: "Refactor auth",
            updatedAt: 0,
            sessionId: "sess_src",
            sessionFile: "/s/source.jsonl",
          },
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
    rightDock: null,
    forkPicker: null,
  });
}

function childThread() {
  return useSessionStore.getState().projects[0].threads.find((t) => t.id !== "t1");
}

beforeEach(() => {
  createSession.mockReset();
  createSession.mockResolvedValue("sess_branch");
  cloneSession.mockReset();
  cloneSession.mockResolvedValue({ cancelled: false });
  forkSession.mockReset();
  forkSession.mockResolvedValue({ text: "make it faster", cancelled: false });
  getForkMessages.mockReset();
  getForkMessages.mockResolvedValue({
    messages: [
      { entryId: "e1", text: "first ask" },
      { entryId: "e2", text: "second ask" },
    ],
  });
  getSessionStats.mockReset();
  getSessionStats.mockResolvedValue({ sessionFile: "/s/branch.jsonl" } as SessionStats);
  getMessages.mockReset();
  getMessages.mockResolvedValue([{ role: "user", content: "hi" }]);
  closeSession.mockReset();
  closeSession.mockResolvedValue(undefined);
  seed();
});

describe("cloneThread (HOY-284)", () => {
  test("clones the source file into a new child thread, no prefill", async () => {
    await useSessionStore.getState().cloneThread("t1");

    expect(createSession.mock.calls[0][1]).toBe("/s/source.jsonl");
    expect(cloneSession).toHaveBeenCalledWith("sess_branch");
    const child = childThread();
    expect(child).toBeDefined();
    expect(child!.parentThreadId).toBe("t1");
    expect(child!.sessionId).toBe("sess_branch");
    expect(child!.title).toContain("Clone");
    // Clone carries no forked message, so the composer is not prefilled.
    expect(useSessionStore.getState().drafts[child!.id]).toBeUndefined();
  });

  test("a cancelled clone tears down the sidecar and adds no thread", async () => {
    cloneSession.mockResolvedValue({ cancelled: true });
    await useSessionStore.getState().cloneThread("t1");
    expect(closeSession).toHaveBeenCalledWith("sess_branch");
    expect(childThread()).toBeUndefined();
  });

  test("refuses to clone while the source is streaming", async () => {
    useSessionStore.setState({ streaming: { t1: true } });
    await useSessionStore.getState().cloneThread("t1");
    expect(createSession).not.toHaveBeenCalled();
    expect(childThread()).toBeUndefined();
  });
});

describe("fork picker (HOY-284)", () => {
  test("openForkPicker loads the forkable messages into the picker", async () => {
    await useSessionStore.getState().openForkPicker("t1");
    const picker = useSessionStore.getState().forkPicker;
    expect(picker?.threadId).toBe("t1");
    expect(picker?.messages.map((m) => m.entryId)).toEqual(["e1", "e2"]);
  });

  test("openForkPicker with no forkable messages shows a notice, no picker", async () => {
    getForkMessages.mockResolvedValue({ messages: [] });
    await useSessionStore.getState().openForkPicker("t1");
    expect(useSessionStore.getState().forkPicker).toBeNull();
  });

  test("pickFork closes the picker and branches from the chosen entry", async () => {
    await useSessionStore.getState().openForkPicker("t1");
    useSessionStore.getState().pickFork("e2");
    // Picker closes immediately; the branch runs via branchFromEntry -> fork.
    expect(useSessionStore.getState().forkPicker).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(forkSession).toHaveBeenCalledWith("sess_branch", "e2");
  });

  test("closeForkPicker dismisses the picker", async () => {
    await useSessionStore.getState().openForkPicker("t1");
    useSessionStore.getState().closeForkPicker();
    expect(useSessionStore.getState().forkPicker).toBeNull();
  });
});
