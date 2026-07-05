import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentEvent,
  GoalEvaluation,
  SessionStats,
  ThreadGoal,
} from "@/lib/types";

import { mockIpcModule } from "./ipcMock";

// HOY-263 Task 5: the renderer-owned goal continuation loop in the `done`
// handler. These tests drive a real turn to capture its live channel, then emit
// a `done` event and assert what the loop does (pause / cap / yield / evaluate
// -> met|continue), with evaluateGoal and the token stats mocked so each branch
// is exercised deterministically. Mirrors the queue.test.ts channel harness.

const sendPrompt =
  mock<(sessionId: string, message: string, channel: unknown) => Promise<void>>();
const getState = mock<(s: string) => Promise<unknown>>();
const getSessionStats = mock<(s: string) => Promise<SessionStats>>();
const evaluateGoal =
  mock<
    (s: string, condition: string, model?: unknown) => Promise<GoalEvaluation>
  >();

mockIpcModule({ sendPrompt, getState, getSessionStats, evaluateGoal });

const { useSessionStore } = await import("@/state/store");

function makeStats(total: number): SessionStats {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    cost: 0,
  };
}

function seed(goal?: Partial<ThreadGoal>): void {
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        path: "/tmp/proj",
        threads: [
          {
            id: "t1",
            title: "T",
            updatedAt: 0,
            sessionId: "sess_live",
            ...(goal
              ? {
                  goal: {
                    condition: "tests pass",
                    status: "active",
                    turns: 0,
                    tokensBaseline: 100,
                    tokensUsed: 0,
                    startedAt: Date.now(),
                    capTurns: 25,
                    ...goal,
                  },
                }
              : {}),
          },
        ],
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
    pendingPermissions: {},
    statuses: {},
    widgets: {},
    drafts: {},
  });
}

// Start a turn so a live channel exists, then clear the kickoff sendPrompt call
// so later assertions count only continuation sends. Returns the channel's
// emit fn.
async function startTurn(): Promise<(event: AgentEvent) => void> {
  await useSessionStore.getState().submitPrompt("t1", "kickoff");
  const channel = sendPrompt.mock.calls[0][2] as {
    onmessage: (e: AgentEvent) => void;
  };
  sendPrompt.mockClear();
  return (event) => channel.onmessage(event);
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function goalOf(): ThreadGoal | undefined {
  return useSessionStore.getState().projects[0].threads[0].goal;
}

function continuationSends(): string[] {
  return sendPrompt.mock.calls
    .map((c) => c[1] as string)
    .filter((m) => m.startsWith("Keep working toward the goal:"));
}

beforeEach(() => {
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue(undefined);
  getState.mockReset();
  getState.mockResolvedValue({ model: { provider: "p", id: "m" } });
  getSessionStats.mockReset();
  getSessionStats.mockResolvedValue(makeStats(100));
  evaluateGoal.mockReset();
  seed();
});

describe("goal continuation loop in the done handler (HOY-263)", () => {
  test("evaluate -> met: goal goes met and no continuation is sent", async () => {
    seed({ status: "active" });
    evaluateGoal.mockResolvedValue({ met: true, reason: "all green" });
    const emit = await startTurn();

    emit({ kind: "done" });
    await flush();
    await flush();

    expect(evaluateGoal).toHaveBeenCalledTimes(1);
    expect(goalOf()?.status).toBe("met");
    expect(goalOf()?.lastReason).toBe("all green");
    expect(continuationSends()).toEqual([]);
  });

  test("evaluate -> continue: lastReason/turns/tokens update and one continuation is sent", async () => {
    seed({ status: "active", turns: 0, tokensBaseline: 100, tokensUsed: 0 });
    getSessionStats.mockResolvedValue(makeStats(500));
    evaluateGoal.mockResolvedValue({ met: false, reason: "not yet" });
    const emit = await startTurn();

    emit({ kind: "done" });
    await flush();
    await flush();

    expect(evaluateGoal).toHaveBeenCalledTimes(1);
    const goal = goalOf();
    expect(goal?.status).toBe("active");
    expect(goal?.lastReason).toBe("not yet");
    expect(goal?.turns).toBe(1);
    expect(goal?.tokensUsed).toBe(400); // 500 now - 100 baseline

    const sends = continuationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toBe(
      "Keep working toward the goal: tests pass.\n" +
        "Evaluator (not yet met): not yet.\n" +
        "Continue with the next concrete step; do not stop until it is demonstrably met.",
    );
  });

  test("evaluateGoal rejection is treated as continue (fail-open across the IPC seam)", async () => {
    seed({ status: "active", turns: 0 });
    evaluateGoal.mockRejectedValue(new Error("no live sidecar"));
    const emit = await startTurn();

    // Must not throw out of the handler; loop continues.
    emit({ kind: "done" });
    await flush();
    await flush();

    const goal = goalOf();
    expect(goal?.status).toBe("active");
    expect(goal?.turns).toBe(1);
    expect(goal?.lastReason).toContain("evaluator error:");
    expect(continuationSends()).toHaveLength(1);
  });

  test("aborted turn pauses the goal without calling the evaluator", async () => {
    seed({ status: "active" });
    const emit = await startTurn();

    emit({ kind: "aborted" });
    emit({ kind: "done" });
    await flush();
    await flush();

    expect(goalOf()?.status).toBe("paused");
    expect(evaluateGoal).not.toHaveBeenCalled();
    expect(continuationSends()).toEqual([]);
  });

  test("cap boundary caps the goal without calling the evaluator", async () => {
    seed({ status: "active", turns: 0, capTurns: 1 });
    const emit = await startTurn();

    emit({ kind: "done" });
    await flush();
    await flush();

    const goal = goalOf();
    expect(goal?.status).toBe("capped");
    expect(goal?.turns).toBe(1);
    expect(evaluateGoal).not.toHaveBeenCalled();
    expect(continuationSends()).toEqual([]);
  });

  test("a pending user prompt yields: goal stays active, no continuation", async () => {
    seed({ status: "active" });
    const emit = await startTurn();
    useSessionStore.setState((s) => ({
      queued: { ...s.queued, t1: { steering: ["do this first"], followUp: [] } },
    }));

    emit({ kind: "done" });
    await flush();
    await flush();

    expect(goalOf()?.status).toBe("active");
    expect(evaluateGoal).not.toHaveBeenCalled();
    expect(continuationSends()).toEqual([]);
  });

  test("a double done on the same channel produces only one continuation", async () => {
    seed({ status: "active" });
    evaluateGoal.mockResolvedValue({ met: false, reason: "keep going" });
    const emit = await startTurn();

    emit({ kind: "done" });
    emit({ kind: "done" });
    await flush();
    await flush();

    expect(evaluateGoal).toHaveBeenCalledTimes(1);
    expect(continuationSends()).toHaveLength(1);
  });

  test("continuationPending blocks a second concurrent continuation", async () => {
    seed({ status: "active" });
    // Hold the evaluator open so the first continuation stays in flight.
    let resolveEval: (v: GoalEvaluation) => void = () => {};
    evaluateGoal.mockReturnValue(
      new Promise<GoalEvaluation>((r) => {
        resolveEval = r;
      }),
    );
    const emitA = await startTurn();

    emitA({ kind: "done" }); // continuation #1: evaluator now pending
    await flush();
    expect(evaluateGoal).toHaveBeenCalledTimes(1);

    // A second turn finishes while the first continuation is still evaluating.
    await useSessionStore.getState().submitPrompt("t1", "poke");
    const channelB = sendPrompt.mock.calls.at(-1)![2] as {
      onmessage: (e: AgentEvent) => void;
    };
    channelB.onmessage({ kind: "done" });
    await flush();
    // Guard held: the second done does not start a second evaluator.
    expect(evaluateGoal).toHaveBeenCalledTimes(1);

    resolveEval({ met: false, reason: "not yet" });
    await flush();
    await flush();

    // Exactly one continuation reached the send path.
    expect(continuationSends()).toHaveLength(1);
  });

  test("re-read guard: a goal cleared during evaluate sends no continuation", async () => {
    seed({ status: "active" });
    let resolveEval: (v: GoalEvaluation) => void = () => {};
    evaluateGoal.mockReturnValue(
      new Promise<GoalEvaluation>((r) => {
        resolveEval = r;
      }),
    );
    const emit = await startTurn();

    emit({ kind: "done" });
    await flush();
    expect(evaluateGoal).toHaveBeenCalledTimes(1);

    // User clears the goal while the evaluator is running.
    useSessionStore.getState().clearGoal("t1");

    resolveEval({ met: false, reason: "not yet" });
    await flush();
    await flush();

    expect(goalOf()).toBeUndefined();
    expect(continuationSends()).toEqual([]);
  });

  test("re-read guard: a condition changed during evaluate sends no continuation", async () => {
    seed({ status: "active", condition: "tests pass" });
    let resolveEval: (v: GoalEvaluation) => void = () => {};
    evaluateGoal.mockReturnValue(
      new Promise<GoalEvaluation>((r) => {
        resolveEval = r;
      }),
    );
    const emit = await startTurn();

    emit({ kind: "done" });
    await flush();

    // Replace the goal with a different condition mid-evaluate.
    await useSessionStore.getState().setGoal("t1", "docs updated");
    sendPrompt.mockClear();

    resolveEval({ met: false, reason: "stale verdict" });
    await flush();
    await flush();

    // The stale verdict must not drive the new condition's goal.
    expect(goalOf()?.condition).toBe("docs updated");
    expect(goalOf()?.lastReason).not.toBe("stale verdict");
    expect(continuationSends()).toEqual([]);
  });
});

describe("/goal resume continuation (HOY-263)", () => {
  test("a paused goal resumes to active and sends exactly one continuation", async () => {
    seed({ status: "paused", condition: "tests pass", lastReason: "not yet" });

    await useSessionStore.getState().submitPrompt("t1", "/goal resume");

    expect(goalOf()?.status).toBe("active");
    const sends = continuationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Keep working toward the goal: tests pass.");
    expect(sends[0]).toContain("Evaluator (not yet met): not yet.");
  });

  test("a capped goal resumes to active and sends exactly one continuation", async () => {
    seed({ status: "capped", condition: "tests pass" });

    await useSessionStore.getState().submitPrompt("t1", "/goal resume");

    expect(goalOf()?.status).toBe("active");
    expect(continuationSends()).toHaveLength(1);
  });

  test("/goal resume does not leak to Pi as raw /goal text", async () => {
    seed({ status: "paused", condition: "tests pass" });

    await useSessionStore.getState().submitPrompt("t1", "/goal resume");

    // The only send is the continuation prompt, never "/goal resume".
    const raw = sendPrompt.mock.calls.map((c) => c[1] as string);
    expect(raw.some((m) => m.includes("/goal resume"))).toBe(false);
  });
});
