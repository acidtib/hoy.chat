import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mentionMarker } from "@/lib/mentions";
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

describe("submitPrompt @ contexts (HOY-220)", () => {
  test("inlines file content and keeps the transcript text clean", async () => {
    seed();
    const draft = `explain ${mentionMarker(fileRef)} to me`;

    await useSessionStore.getState().submitPrompt("t1", draft);

    expect(readContextFile).toHaveBeenCalledWith("/tmp/proj", "src/foo.ts");
    const message = sendPrompt.mock.calls[0][1];
    expect(message).toContain("<context>");
    expect(message).toContain('<file path="src/foo.ts">');
    expect(message).toContain("FILE CONTENTS");
    // The mention marker is replaced by the label in the human-readable text.
    expect(message).toContain("explain foo.ts to me");
    // The transcript keeps the clean text (not the inlined block) plus the ref.
    const userTurn = useSessionStore.getState().turns["t1"][0];
    expect(userTurn).toMatchObject({
      role: "user",
      text: "explain foo.ts to me",
      contexts: [fileRef],
    });
  });

  test("inlines a referenced thread's transcript from the store", async () => {
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

    await useSessionStore
      .getState()
      .submitPrompt("t1", `summarize ${mentionMarker(threadRef)}`);

    const message = sendPrompt.mock.calls[0][1];
    expect(message).toContain('<thread title="Other">');
    expect(message).toContain("user: hi");
    expect(message).toContain("assistant: hello there");
  });

  test("a plain message sends verbatim with no context block", async () => {
    seed();
    await useSessionStore.getState().submitPrompt("t1", "just text");
    expect(sendPrompt.mock.calls[0][1]).toBe("just text");
    expect(readContextFile).not.toHaveBeenCalled();
  });
});
