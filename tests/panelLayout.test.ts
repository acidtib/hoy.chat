import { describe, expect, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

// None of the ipc surface is exercised here; the store just needs it mocked
// at import time.
mockIpcModule();

const { useSessionStore } = await import("@/state/store");

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
    panels: panelWidths.map((width, i) => ({ id: `t${i + 1}`, width })),
    bodyWidth,
    activeThreadId: "t1",
  });
}

function widths(): number[] {
  return useSessionStore.getState().panels.map((p) => p.width);
}

describe("closePanel widths", () => {
  test("closing overflowing panels re-fits survivors to the body instead of stacking widths", () => {
    // Three panels at the minimum overflow an 800px body; the strip scrolls.
    seed([460, 460, 460], 800);

    useSessionStore.getState().closePanel("t3");
    // Survivors are already at the minimum; they keep their width (still
    // overflowing) rather than absorbing the closed panel's 460px.
    expect(widths()).toEqual([460, 460]);

    useSessionStore.getState().closePanel("t2");
    // The last panel fits the body exactly, not the stacked total.
    expect(widths()).toEqual([800]);
  });
});
