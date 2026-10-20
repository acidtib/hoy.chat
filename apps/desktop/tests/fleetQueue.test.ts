import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

const workspace = {
  projects: [
    {
      id: "p1",
      name: "hoy",
      path: "/tmp/hoy",
      threads: [
        {
          id: "t-old",
          title: "HOY-0 old",
          updatedAt: 0,
          renamed: true,
          agent: "Explore",
          fleetRun: { startedAt: 1 },
        },
        {
          id: "t-child",
          title: "child",
          updatedAt: 0,
          renamed: true,
          parentThreadId: "t-old",
          spawnedBy: { type: "general-purpose", agentId: "a1" },
        },
      ],
      fleet: {
        queue: [{ agent: "Plan", issue: { id: "q1" }, queuedAt: 0 }],
        concurrency: { Explore: 2 },
      },
    },
  ],
};
mockIpcModule({
  loadWorkspace: mock(async () => workspace),
  listSubagents: mock(async () => []),
});

const { useSessionStore } = await import("@/state/store");
import type { LinearIssue, SubagentDef } from "@/lib/types";

function issue(id: string): LinearIssue {
  return {
    id,
    identifier: `HOY-${id}`,
    title: `Issue ${id}`,
    description: null,
    url: "",
    priority: 3,
    priorityLabel: "Medium",
    estimate: null,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
  };
}

const explore = { name: "Explore", enabled: true } as SubagentDef;
const submitPrompt = mock(async () => {});
const project = () => useSessionStore.getState().projects[0];
const threadFor = (id: string) =>
  project().threads.find((t) => t.linearIssue?.id === id);

// A run ends when its thread stops streaming; the watcher then settles async.
async function endRun(threadId: string, turn: Record<string, unknown> = {}) {
  useSessionStore.setState((s) => ({ streaming: { ...s.streaming, [threadId]: true } }));
  useSessionStore.setState((s) => ({
    turns: { ...s.turns, [threadId]: [{ role: "assistant", blocks: [], ...turn }] },
    streaming: { ...s.streaming, [threadId]: false },
  }));
  for (let i = 0; i < 20; i++) await Bun.sleep(1);
}

beforeAll(async () => {
  await useSessionStore.getState().initWorkspace();
});

test("a run left open on disk loads as interrupted", () => {
  const run = useSessionStore
    .getState()
    .projects[0].threads.find((t) => t.id === "t-old")!.fleetRun!;
  expect(run.outcome).toBe("interrupted");
  expect(run.endedAt).toBeGreaterThan(0);
});

test("retired agent names load as their replacements", () => {
  const p = useSessionStore.getState().projects[0];
  expect(p.threads.find((t) => t.id === "t-old")!.agent).toBe("Researcher");
  expect(p.threads.find((t) => t.id === "t-child")!.spawnedBy!.type).toBe("Coder");
  expect(p.fleet!.queue[0].agent).toBe("Architect");
  expect(p.fleet!.concurrency).toEqual({ Researcher: 2 });
});

describe("fleet queue", () => {
  beforeEach(() => {
    submitPrompt.mockClear();
    useSessionStore.setState({
      projects: [{ id: "p1", name: "hoy", path: "/tmp/hoy", threads: [] }],
      subagents: [explore],
      submitPrompt,
      panels: [],
      turns: {},
      streaming: {},
      threadErrors: {},
    });
  });

  test("starts the first issue and queues the rest behind it", () => {
    const s = useSessionStore.getState();
    s.enqueueIssue("p1", issue("1"), "Explore");
    s.enqueueIssue("p1", issue("2"), "Explore");
    expect(threadFor("1")?.fleetRun?.endedAt).toBeUndefined();
    expect(threadFor("2")).toBeUndefined();
    expect(project().fleet!.queue.map((q) => q.issue.id)).toEqual(["2"]);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  test("a clean finish records the run and starts the next issue", async () => {
    const s = useSessionStore.getState();
    s.enqueueIssue("p1", issue("1"), "Explore");
    s.enqueueIssue("p1", issue("2"), "Explore");
    await endRun(threadFor("1")!.id);
    expect(threadFor("1")!.fleetRun!.outcome).toBe("done");
    expect(threadFor("2")).toBeDefined();
    expect(project().fleet!.queue).toHaveLength(0);
  });

  test("a stopped run halts the queue until Resume", async () => {
    const s = useSessionStore.getState();
    s.enqueueIssue("p1", issue("1"), "Explore");
    s.enqueueIssue("p1", issue("2"), "Explore");
    await endRun(threadFor("1")!.id, { aborted: true, error: "Request was aborted" });
    expect(threadFor("1")!.fleetRun!.outcome).toBe("stopped");
    expect(threadFor("2")).toBeUndefined();
    useSessionStore.getState().resumeAgent("p1", "Explore");
    expect(threadFor("1")!.fleetRun!.acknowledged).toBe(true);
    expect(threadFor("2")).toBeDefined();
  });

  test("an abort reported only as an error still counts as stopped", async () => {
    useSessionStore.getState().enqueueIssue("p1", issue("1"), "Explore");
    await endRun(threadFor("1")!.id, { error: "The operation was aborted." });
    expect(threadFor("1")!.fleetRun!.outcome).toBe("stopped");
  });

  test("a failed first prompt ends the run as an error", async () => {
    useSessionStore.getState().enqueueIssue("p1", issue("1"), "Explore");
    const id = threadFor("1")!.id;
    useSessionStore.setState((st) => ({ threadErrors: { ...st.threadErrors, [id]: "spawn failed" } }));
    for (let i = 0; i < 20; i++) await Bun.sleep(1);
    expect(threadFor("1")!.fleetRun!.outcome).toBe("error");
  });

  test("raising concurrency starts queued work alongside", () => {
    const s = useSessionStore.getState();
    s.enqueueIssue("p1", issue("1"), "Explore");
    s.enqueueIssue("p1", issue("2"), "Explore");
    s.setAgentConcurrency("p1", "Explore", 2);
    expect(threadFor("2")).toBeDefined();
  });

  test("nothing starts for a disabled or unknown agent", () => {
    useSessionStore.setState({ subagents: [{ ...explore, enabled: false }] });
    useSessionStore.getState().enqueueIssue("p1", issue("1"), "Explore");
    useSessionStore.getState().enqueueIssue("p1", issue("2"), "Plan");
    expect(project().threads).toHaveLength(0);
    expect(project().fleet!.queue).toHaveLength(2);
  });

  test("reorder and unassign only touch the queue", () => {
    const s = useSessionStore.getState();
    s.setAgentConcurrency("p1", "Explore", 1);
    useSessionStore.setState({ subagents: [] });
    s.enqueueIssue("p1", issue("1"), "Explore");
    s.enqueueIssue("p1", issue("2"), "Explore");
    s.moveQueuedIssue("p1", "2", -1);
    expect(project().fleet!.queue.map((q) => q.issue.id)).toEqual(["2", "1"]);
    s.unqueueIssue("p1", "2");
    expect(project().fleet!.queue.map((q) => q.issue.id)).toEqual(["1"]);
  });
});
