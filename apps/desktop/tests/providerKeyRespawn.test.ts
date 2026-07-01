import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Thread } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// A credential change respawns idle sidecars under their existing sessionIds
// (HOY-196), so the store must clear its per-session reconcile guards; the
// next prompt re-applies the thread's permission mode to the fresh process.
const setPermissionMode =
  mock<(sessionId: string, mode: string) => Promise<void>>();
const saveProviderKey = mock<(provider: string, key: string) => Promise<void>>();
const getState = mock<(sessionId: string) => Promise<unknown>>();
const sendPrompt = mock<() => Promise<void>>();

mockIpcModule({ setPermissionMode, saveProviderKey, getState, sendPrompt });

const { useSessionStore } = await import("@/state/store");

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
    turns: {},
    streaming: {},
    stats: {},
    threadErrors: {},
    pendingPermissions: {},
    drafts: {},
  });
}

async function promptOnce() {
  await useSessionStore.getState().submitPrompt("t1", "hello");
  // The mocked Channel never delivers a done event; reset the streaming flag
  // so the next submit isn't refused.
  useSessionStore.setState((s) => ({ streaming: { ...s.streaming, t1: false } }));
}

beforeEach(() => {
  setPermissionMode.mockReset();
  saveProviderKey.mockReset();
  getState.mockReset();
  sendPrompt.mockReset();
  getState.mockResolvedValue({ model: null });
  sendPrompt.mockResolvedValue();
  setPermissionMode.mockResolvedValue();
  saveProviderKey.mockResolvedValue();
});

describe("provider key save resets session guards", () => {
  test("the thread mode re-applies on the first prompt after a key save", async () => {
    // Use a distinct session id so guards from other test files cannot collide.
    seed({ sessionId: "sess_respawn", permissionMode: "plan" });

    await promptOnce();
    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith("sess_respawn", "plan");

    // Idempotence guard: a second prompt does not re-send the mode.
    await promptOnce();
    expect(setPermissionMode).toHaveBeenCalledTimes(1);

    // Key save respawned the sidecar behind the same sessionId; the guard is
    // cleared and the next prompt re-applies the mode to the fresh process.
    await useSessionStore.getState().saveProviderKey("anthropic", "sk-test");
    expect(saveProviderKey).toHaveBeenCalledWith("anthropic", "sk-test");

    await promptOnce();
    expect(setPermissionMode).toHaveBeenCalledTimes(2);
  });
});
