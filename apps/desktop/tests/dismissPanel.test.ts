import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

// HOY-301: closing a subagent panel dismisses it (keeps the sidecar running and
// the transcript intact); closing a root thread's panel tears it down as before.
const closeSession = mock<(s: string) => Promise<void>>();
mockIpcModule({ closeSession });

const { useSessionStore } = await import("@/state/store");

// A parent (root) thread and its running subagent child, both open as panels.
function seed() {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          { id: "root", title: "Root", updatedAt: 0, sessionId: "sess_root" },
          {
            id: "kid",
            title: "Sub",
            updatedAt: 0,
            sessionId: "sess_kid",
            parentThreadId: "root",
          },
        ],
      },
    ],
    panels: [
      { id: "root", width: 1 },
      { id: "kid", width: 1 },
    ],
    activeThreadId: "kid",
    bodyWidth: 1000,
    turns: { kid: [{ role: "user", text: "go" }] },
    streaming: { kid: true },
    stats: {},
    threadErrors: {},
    queued: {},
    composerAttachments: {},
    notices: {},
    drafts: {},
    sessionTree: {},
    rightDock: null,
    forkPicker: null,
    expandedThreadId: null,
    focusRequest: null,
  });
}

function panelIds() {
  return useSessionStore.getState().panels.map((p) => p.id);
}
function threadSessionId(id: string) {
  return useSessionStore
    .getState()
    .projects[0].threads.find((t) => t.id === id)?.sessionId;
}

beforeEach(() => {
  closeSession.mockReset();
  closeSession.mockResolvedValue(undefined);
  seed();
});

describe("requestPanelClose / dismissPanel (HOY-301)", () => {
  test("closing a running subagent panel dismisses it without teardown", () => {
    useSessionStore.getState().requestPanelClose("kid");
    // Removed from the strip...
    expect(panelIds()).toEqual(["root"]);
    // ...but the sidecar is NOT killed and the state survives.
    expect(closeSession).not.toHaveBeenCalled();
    expect(threadSessionId("kid")).toBe("sess_kid");
    expect(useSessionStore.getState().turns.kid).toBeDefined();
    expect(useSessionStore.getState().streaming.kid).toBe(true);
    // Active thread falls to the surviving panel.
    expect(useSessionStore.getState().activeThreadId).toBe("root");
  });

  test("the dismissed subagent is reopenable with its transcript intact", () => {
    useSessionStore.getState().requestPanelClose("kid");
    useSessionStore.getState().openThread("kid");
    expect(panelIds()).toContain("kid");
    expect(useSessionStore.getState().turns.kid?.length).toBe(1);
  });

  test("closing a root thread panel tears its sidecar down (not streaming)", () => {
    useSessionStore.setState({ streaming: {} });
    useSessionStore.getState().requestPanelClose("root");
    // Root close goes through the kill-on-close teardown.
    expect(closeSession).toHaveBeenCalledWith("sess_root");
    expect(panelIds()).toEqual(["kid"]);
  });

  test("dismissPanel is a no-op for a panel that is not open", () => {
    const before = panelIds();
    useSessionStore.getState().dismissPanel("nope");
    expect(panelIds()).toEqual(before);
  });
});
