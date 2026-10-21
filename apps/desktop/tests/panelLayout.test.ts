import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

// None of the ipc surface is exercised here. The store needs it mocked
// at import time.
mockIpcModule();

const { useSessionStore } = await import("@/state/store");

// One tab split into panels of the given widths.
function seed(panelWidths: number[], bodyWidth: number) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: panelWidths.map((_, i) => ({
          id: `t${i + 1}`,
          title: "Thread",
          updatedAt: 0,
          sessionId: null,
        })),
      },
    ],
    panels: panelWidths.map((width, i) => ({ id: `t${i + 1}`, width, tabId: "tab1" })),
    bodyWidth,
    activeThreadId: "t1",
  });
}

function widths(): number[] {
  return useSessionStore.getState().panels.map((p) => p.width);
}

describe("closePanel widths", () => {
  test("closing a split tab's overflowing panels re-fits the survivors to the body", () => {
    // Three panels at the minimum overflow an 800px body. The tab scrolls.
    seed([460, 460, 460], 800);

    useSessionStore.getState().closePanel("t3");
    // Survivors are already at the minimum. They keep their width (still
    // overflowing) rather than absorbing the closed panel's 460px.
    expect(widths()).toEqual([460, 460]);

    useSessionStore.getState().closePanel("t2");
    // The last panel fits the body exactly, not the stacked total.
    expect(widths()).toEqual([800]);
  });
});
