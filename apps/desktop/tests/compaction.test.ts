import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompactionResult, PiState, SessionStats } from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

const compact = mock<(s: string, ci?: string) => Promise<CompactionResult>>();
const setAutoCompaction = mock<(s: string, e: boolean) => Promise<void>>();
const getState = mock<(s: string) => Promise<PiState>>();
const getSessionStats = mock<(s: string) => Promise<SessionStats>>();

mockIpcModule({ compact, setAutoCompaction, getState, getSessionStats });

const { useSessionStore } = await import("@/state/store");

function seed(overrides: Record<string, unknown> = {}) {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [{ id: "t1", title: "T", updatedAt: 0, sessionId: "sess_live" }],
      },
    ],
    turns: {},
    streaming: {},
    stats: {},
    compacting: {},
    autoCompaction: {},
    notices: {},
    threadErrors: {},
    ...overrides,
  });
}

beforeEach(() => {
  compact.mockReset();
  compact.mockResolvedValue({ tokensBefore: 1000, estimatedTokensAfter: 200 });
  setAutoCompaction.mockReset();
  setAutoCompaction.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ autoCompactionEnabled: true } as PiState);
  getSessionStats.mockReset();
  getSessionStats.mockResolvedValue({} as SessionStats);
  seed();
});

describe("compact (HOY-229)", () => {
  test("dispatches compact and surfaces a result notice", async () => {
    await useSessionStore.getState().compact("t1", "focus on the API");
    expect(compact).toHaveBeenCalledWith("sess_live", "focus on the API");
    // Refreshes the usage meter afterward.
    expect(getSessionStats).toHaveBeenCalledWith("sess_live");
    // A notice was pushed and the compacting flag reset.
    expect(useSessionStore.getState().notices["t1"]?.length).toBeGreaterThan(0);
    expect(useSessionStore.getState().compacting["t1"]).toBe(false);
  });

  test("is gated while streaming", async () => {
    seed({ streaming: { t1: true } });
    await useSessionStore.getState().compact("t1");
    expect(compact).not.toHaveBeenCalled();
  });

  test("surfaces a failure notice, not a silent no-op", async () => {
    compact.mockRejectedValueOnce(new Error("boom"));
    await useSessionStore.getState().compact("t1");
    const notices = useSessionStore.getState().notices["t1"] ?? [];
    expect(notices.some((n) => n.type === "error")).toBe(true);
    expect(useSessionStore.getState().compacting["t1"]).toBe(false);
  });
});

describe("setAutoCompaction (HOY-229)", () => {
  test("dispatches set_auto_compaction and reflects get_state", async () => {
    await useSessionStore.getState().setAutoCompaction("t1", true);
    expect(setAutoCompaction).toHaveBeenCalledWith("sess_live", true);
    expect(useSessionStore.getState().autoCompaction["t1"]).toBe(true);
  });

  test("reverts on failure", async () => {
    setAutoCompaction.mockRejectedValueOnce(new Error("nope"));
    seed({ autoCompaction: { t1: true } });
    await useSessionStore.getState().setAutoCompaction("t1", false);
    expect(useSessionStore.getState().autoCompaction["t1"]).toBe(true);
  });
});
