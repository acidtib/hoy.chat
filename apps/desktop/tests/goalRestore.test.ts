import { describe, expect, mock, test } from "bun:test";
import type { ThreadGoal, Workspace } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

// Named mock this file asserts against; the shared helper fills in the rest of
// the ipc surface the store needs at import time.
const loadWorkspace = mock<() => Promise<Workspace>>();

mockIpcModule({ loadWorkspace });

const { useSessionStore } = await import("@/state/store");

function goal(overrides: Partial<ThreadGoal>): ThreadGoal {
  return {
    condition: "tests pass",
    status: "active",
    turns: 3,
    tokensBaseline: 100,
    tokensUsed: 250,
    startedAt: 1_717_000_000_000,
    capTurns: 25,
    ...overrides,
  };
}

// HOY-263 load semantics (restoreGoal, called from initWorkspace's per-thread
// .map()): a restored goal must never auto-run just because the app reopened.
describe("initWorkspace goal restore", () => {
  test("an active goal restores as paused with counters reset", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t_active",
              title: "goal thread",
              updatedAt: 1,
              goal: goal({ status: "active" }),
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toBeDefined();
    expect(thread.goal?.status).toBe("paused");
    expect(thread.goal?.turns).toBe(0);
    expect(thread.goal?.tokensUsed).toBe(0);
    // baseline absorbs whatever was already used, so the next evaluate() call
    // measures a fresh delta rather than replaying stale usage.
    expect(thread.goal?.tokensBaseline).toBe(350);
    expect(thread.goal?.startedAt).toBeGreaterThanOrEqual(1_717_000_000_000);
  });

  test("a met goal is dropped, not restored", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t_met",
              title: "goal thread",
              updatedAt: 1,
              goal: goal({ status: "met" }),
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toBeUndefined();
  });

  test("a cleared goal is dropped, not restored", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t_cleared",
              title: "goal thread",
              updatedAt: 1,
              goal: goal({ status: "cleared" }),
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toBeUndefined();
  });

  test("a paused goal passes through unchanged", async () => {
    const pausedGoal = goal({ status: "paused", turns: 5, tokensUsed: 999 });
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t_paused",
              title: "goal thread",
              updatedAt: 1,
              goal: pausedGoal,
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toEqual(pausedGoal);
  });

  test("a capped goal passes through unchanged", async () => {
    const cappedGoal = goal({ status: "capped", turns: 25, tokensUsed: 1234 });
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [
            {
              id: "t_capped",
              title: "goal thread",
              updatedAt: 1,
              goal: cappedGoal,
            },
          ],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toEqual(cappedGoal);
  });

  test("a thread with no goal is unaffected", async () => {
    loadWorkspace.mockResolvedValue({
      projects: [
        {
          id: "p1",
          name: "proj",
          path: "/tmp/proj",
          threads: [{ id: "t_none", title: "New thread", updatedAt: 1 }],
        },
      ],
    });

    await useSessionStore.getState().initWorkspace();

    const thread = useSessionStore.getState().projects[0].threads[0];
    expect(thread.goal).toBeUndefined();
  });
});
