import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionStats } from "@/lib/types";

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
const getState = mock<(s: string) => Promise<unknown>>();

mockIpcModule({ sendPrompt, getState });

const { useSessionStore } = await import("@/state/store");

function seed(stats: Record<string, SessionStats> = {}) {
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
    stats,
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
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  seed();
});

describe("submitPrompt /goal interception (HOY-263)", () => {
  test("/goal <condition> sets the goal and sends the condition as the first prompt", async () => {
    seed({
      t1: {
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        cost: 0,
      },
    });

    await useSessionStore.getState().submitPrompt("t1", "/goal tests pass");

    const goal = useSessionStore.getState().projects[0].threads[0].goal;
    expect(goal).toBeDefined();
    expect(goal?.status).toBe("active");
    expect(goal?.condition).toBe("tests pass");
    expect(goal?.turns).toBe(0);
    expect(goal?.tokensBaseline).toBe(30);
    expect(goal?.tokensUsed).toBe(0);

    // The condition is sent through the normal prompt path, not swallowed.
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][1]).toBe("tests pass");
  });

  test("/goal pause pauses without sending a prompt", async () => {
    useSessionStore.setState((s) => ({
      projects: [
        {
          ...s.projects[0],
          threads: [
            {
              ...s.projects[0].threads[0],
              goal: {
                condition: "tests pass",
                status: "active",
                turns: 1,
                tokensBaseline: 0,
                tokensUsed: 10,
                startedAt: Date.now(),
                capTurns: 25,
              },
            },
          ],
        },
      ],
    }));

    await useSessionStore.getState().submitPrompt("t1", "/goal pause");

    const goal = useSessionStore.getState().projects[0].threads[0].goal;
    expect(goal?.status).toBe("paused");
    expect(sendPrompt).not.toHaveBeenCalled();
    // No turns are appended for the built-in.
    expect(useSessionStore.getState().turns["t1"]).toBeUndefined();
  });

  test("/goal clear removes the goal without sending a prompt", async () => {
    useSessionStore.setState((s) => ({
      projects: [
        {
          ...s.projects[0],
          threads: [
            {
              ...s.projects[0].threads[0],
              goal: {
                condition: "tests pass",
                status: "paused",
                turns: 1,
                tokensBaseline: 0,
                tokensUsed: 10,
                startedAt: Date.now(),
                capTurns: 25,
              },
            },
          ],
        },
      ],
    }));

    await useSessionStore.getState().submitPrompt("t1", "/goal clear");

    const goal = useSessionStore.getState().projects[0].threads[0].goal;
    expect(goal).toBeUndefined();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test("/goal (status) with no goal set surfaces a notice and sends no prompt", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/goal");

    expect(sendPrompt).not.toHaveBeenCalled();
    const notices = useSessionStore.getState().notices["t1"] ?? [];
    expect(notices.length).toBe(1);
    expect(notices[0].message).toContain("No goal set");
  });

  test("a non-goal slash command goes to Pi via sendPrompt", async () => {
    await useSessionStore.getState().submitPrompt("t1", "/goalish arg");

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][1]).toBe("/goalish arg");
    expect(useSessionStore.getState().projects[0].threads[0].goal).toBeUndefined();
  });
});
