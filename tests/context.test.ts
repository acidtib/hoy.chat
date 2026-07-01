import { beforeEach, describe, expect, mock, test } from "bun:test";
import { contextKey } from "@/lib/types";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

const sendPrompt =
  mock<
    (
      sessionId: string,
      message: string,
      channel: unknown,
      images?: unknown,
      behavior?: string,
    ) => Promise<void>
  >();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const readContextFile =
  mock<(root: string, path: string) => Promise<string>>();
const listProjectPaths =
  mock<(root: string, query: string, limit: number) => Promise<unknown[]>>();

mockIpcModule({ sendPrompt, getState, readContextFile, listProjectPaths });

const { useSessionStore } = await import("@/state/store");

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
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
    composerContexts: {},
    pendingPermissions: {},
    notices: {},
    statuses: {},
    widgets: {},
    drafts: {},
  });
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  readContextFile.mockReset();
  readContextFile.mockResolvedValue("FILE CONTENTS");
  listProjectPaths.mockReset();
  listProjectPaths.mockResolvedValue([]);
});

const fileRef = { kind: "file" as const, path: "src/foo.ts", name: "foo.ts" };
const threadRef = { kind: "thread" as const, threadId: "t2", title: "Other" };

describe("composerContexts (HOY-220)", () => {
  test("add dedups by key; remove and clear drop entries", () => {
    seed();
    const store = useSessionStore.getState();
    store.addContext("t1", fileRef);
    store.addContext("t1", fileRef);
    expect(useSessionStore.getState().composerContexts["t1"]).toHaveLength(1);

    store.addContext("t1", threadRef);
    expect(useSessionStore.getState().composerContexts["t1"]).toHaveLength(2);

    store.removeContext("t1", contextKey(fileRef));
    expect(useSessionStore.getState().composerContexts["t1"]).toEqual([
      threadRef,
    ]);

    store.clearContexts("t1");
    expect(useSessionStore.getState().composerContexts["t1"]).toBeUndefined();
  });

  test("submit inlines file content and clears the contexts", async () => {
    seed();
    useSessionStore.getState().addContext("t1", fileRef);

    await useSessionStore.getState().submitPrompt("t1", "explain this");

    expect(readContextFile).toHaveBeenCalledWith("/tmp/proj", "src/foo.ts");
    const message = sendPrompt.mock.calls[0][1];
    expect(message).toContain("<context>");
    expect(message).toContain('<file path="src/foo.ts">');
    expect(message).toContain("FILE CONTENTS");
    expect(message).toContain("explain this");
    // Cleared so it cannot be attached twice.
    expect(useSessionStore.getState().composerContexts["t1"]).toBeUndefined();
    // The transcript keeps the user's clean text, not the inlined block.
    const userTurn = useSessionStore.getState().turns["t1"][0];
    expect(userTurn).toMatchObject({ role: "user", text: "explain this" });
  });

  test("submit inlines a referenced thread's transcript from the store", async () => {
    seed();
    useSessionStore.setState((s) => ({
      turns: {
        ...s.turns,
        t2: [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            blocks: [{ kind: "text", content: "hello there" }],
            streaming: false,
          },
        ],
      },
    }));
    useSessionStore.getState().addContext("t1", threadRef);

    await useSessionStore.getState().submitPrompt("t1", "summarize");

    const message = sendPrompt.mock.calls[0][1];
    expect(message).toContain('<thread title="Other">');
    expect(message).toContain("user: hi");
    expect(message).toContain("assistant: hello there");
  });

  test("no contexts sends the plain message (no block)", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "just text");
    expect(sendPrompt.mock.calls[0][1]).toBe("just text");
    expect(readContextFile).not.toHaveBeenCalled();
  });
});
