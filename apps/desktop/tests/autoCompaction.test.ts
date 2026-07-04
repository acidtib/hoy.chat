import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// HOY-275: auto-compaction is a global default (renderer pref), applied to
// every session on spawn via set_auto_compaction. These tests drive submitPrompt
// through a fresh session and assert the pref reaches the new sidecar.
const setAutoCompaction =
  mock<(sessionId: string, enabled: boolean) => Promise<void>>();
const createSession = mock<() => Promise<string>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const sendPrompt = mock<() => Promise<void>>();
const getMessages = mock<() => Promise<unknown[]>>();

mockIpcModule({
  setAutoCompaction,
  createSession,
  getState,
  sendPrompt,
  getMessages,
});

const { useSessionStore } = await import("@/state/store");
const { usePrefsStore } = await import("@/state/prefs");

function seed(thread: Partial<Thread>) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "Thread", updatedAt: 0, sessionId: null, ...thread },
        ],
      },
    ],
    panels: [],
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    modelSelecting: {},
    defaultModel: null,
  });
}

beforeEach(() => {
  setAutoCompaction.mockReset();
  setAutoCompaction.mockResolvedValue(undefined);
  createSession.mockReset();
  getState.mockReset();
  getState.mockResolvedValue({});
  sendPrompt.mockReset();
  getMessages.mockReset();
  usePrefsStore.getState().reset();
});
afterEach(() => {
  usePrefsStore.getState().reset();
});

describe("auto-compaction default at spawn", () => {
  test("on by default: a fresh session is told set_auto_compaction(true)", async () => {
    seed({ sessionId: null });
    createSession.mockResolvedValue("sess_ac_on");

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setAutoCompaction).toHaveBeenCalledWith("sess_ac_on", true);
  });

  test("pref off: the new session is told set_auto_compaction(false)", async () => {
    usePrefsStore.getState().setPref("autoCompaction", false);
    seed({ sessionId: null });
    createSession.mockResolvedValue("sess_ac_off");

    await useSessionStore.getState().submitPrompt("t1", "hello");

    expect(setAutoCompaction).toHaveBeenCalledWith("sess_ac_off", false);
  });

  test("applied once per session: repeat prompts skip the redundant RPC", async () => {
    // A thread already on a session still gets the default on its first prompt,
    // then the per-session guard suppresses the redundant call on the next.
    seed({ sessionId: "sess_live_ac" });

    await useSessionStore.getState().submitPrompt("t1", "hello");
    await useSessionStore.getState().submitPrompt("t1", "again");

    expect(setAutoCompaction).toHaveBeenCalledTimes(1);
    expect(setAutoCompaction).toHaveBeenCalledWith("sess_live_ac", true);
  });
});

describe("setAutoCompaction fan-out (HOY-275)", () => {
  test("toggling pushes the new value to a currently-live session", async () => {
    seed({ sessionId: null });
    createSession.mockResolvedValue("sess_fanout");
    // Spawn the session so it registers as live (applyAutoCompaction).
    await useSessionStore.getState().submitPrompt("t1", "hello");
    setAutoCompaction.mockClear();

    await useSessionStore.getState().setAutoCompaction(false);

    expect(setAutoCompaction).toHaveBeenCalledWith("sess_fanout", false);
  });
});
