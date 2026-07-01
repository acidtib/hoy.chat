import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

// None of the ipc surface is exercised here; the store just needs it mocked
// at import time.
mockIpcModule();

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
