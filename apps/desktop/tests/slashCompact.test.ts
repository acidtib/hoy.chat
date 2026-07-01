import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompactionResult, SlashCommand } from "@/lib/types";

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
const compact = mock<(s: string, ci?: string) => Promise<CompactionResult>>();
const getCommands = mock<(s: string) => Promise<SlashCommand[]>>();
const getState = mock<(s: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, compact, getCommands, getState });

const { useSessionStore } = await import("@/state/store");

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
    compacting: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
    notices: {},
  });
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  compact.mockReset();
  compact.mockResolvedValue({ tokensBefore: 1000, estimatedTokensAfter: 200 });
  getCommands.mockReset();
  getCommands.mockResolvedValue([]);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  seed();
});

describe("submitPrompt /compact interception (HOY-223)", () => {
  test("/compact with instructions calls compact and never sends a prompt", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/compact focus on X");

    expect(compact).toHaveBeenCalledWith("sess_live", "focus on X");
    expect(sendPrompt).not.toHaveBeenCalled();
    // No user/assistant turns are appended for the built-in.
    expect(useSessionStore.getState().turns["t1"]).toBeUndefined();
  });

  test("bare /compact calls compact with no custom instructions", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/compact");

    expect(compact).toHaveBeenCalledWith("sess_live", undefined);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test("a non-compact slash command goes to Pi via sendPrompt", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/somecmd arg");

    expect(compact).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][1]).toBe("/somecmd arg");
  });
});
