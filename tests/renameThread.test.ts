import { describe, expect, mock, test } from "bun:test";

// Mock the ipc module before anything imports it; the store needs the full
// export surface at import time but none of it is exercised here.
mock.module("@/lib/ipc", () => ({
  Channel: class {},
  abort: mock(),
  activeSessionId: mock(),
  closeSession: mock(),
  createSession: mock(),
  deleteSessionFile: mock(),
  getMessages: mock(),
  getSessionStats: mock(),
  getState: mock(),
  listModels: mock(),
  loadWorkspace: mock(),
  pickDirectory: mock(),
  providerStatuses: mock(),
  removeProviderKey: mock(),
  saveProviderKey: mock(),
  saveWorkspace: mock(),
  sendPrompt: mock(),
  setModel: mock(),
  supportedProviders: mock(),
}));

const { useSessionStore } = await import("@/state/store");

function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "t1", title: "Old title", updatedAt: 5, sessionId: null },
        ],
      },
    ],
  });
}

function title(): string {
  return useSessionStore.getState().projects[0].threads[0].title;
}

describe("renameThread", () => {
  test("sets the trimmed title", () => {
    seed();
    useSessionStore.getState().renameThread("t1", "  Fresh name  ");
    expect(title()).toBe("Fresh name");
  });

  test("empty or whitespace-only titles are a no-op", () => {
    seed();
    useSessionStore.getState().renameThread("t1", "   ");
    expect(title()).toBe("Old title");
  });

  test("unknown thread is a no-op", () => {
    seed();
    useSessionStore.getState().renameThread("missing", "Anything");
    expect(title()).toBe("Old title");
  });
});
