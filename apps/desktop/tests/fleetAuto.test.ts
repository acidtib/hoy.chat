import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

const workspace = {
  projects: [
    {
      id: "p1",
      name: "hoy",
      path: "/tmp/hoy",
      threads: [],
      linear: { teamId: "t1", teamKey: "HOY", teamName: "Hoy" },
      fleet: { queue: [], concurrency: {}, auto: true },
    },
  ],
};

const dispatchDecision = mock(async (..._args: unknown[]) => ({
  ready: true,
  agent: "Coder",
  confidence: 0.9,
  reason: "Implementation work.",
  cost: 0.001,
}));
const linearComment = mock(async () => {});
const submitPrompt = mock(async () => {});
mockIpcModule({
  loadWorkspace: mock(async () => workspace),
  listSubagents: mock(async () => []),
  projectIsGitRepo: mock(async () => true),
  dispatchDecision,
  linearComment,
});

const { useSessionStore } = await import("@/state/store");
const { useLinearStore } = await import("@/state/linear");
const { usePrefsStore } = await import("@/state/prefs");
import type { LinearIssue, SubagentDef } from "@/lib/types";

function issue(id: string, over: Partial<LinearIssue> = {}): LinearIssue {
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
    updatedAt: `2026-10-19T00:00:0${id}.000Z`,
    ...over,
  };
}

const coder = { name: "Coder", description: "Implements changes.", enabled: true } as SubagentDef;
const researcher = { name: "Researcher", description: "Investigates.", enabled: true } as SubagentDef;

const setIssues = (items: LinearIssue[]) =>
  useLinearStore.setState({
    issues: { p1: { items, loading: false, error: null, fetchedAt: Date.now() } },
  });

const decisions = () => useSessionStore.getState().projects[0].fleet!.decisions ?? {};

// Restored so later test files in the same run get the real action.
const realSubmitPrompt = useSessionStore.getState().submitPrompt;
beforeAll(async () => {
  await useSessionStore.getState().initWorkspace();
});
afterAll(() => useSessionStore.setState({ submitPrompt: realSubmitPrompt }));

beforeEach(() => {
  dispatchDecision.mockClear();
  linearComment.mockClear();
  submitPrompt.mockClear();
  useSessionStore.setState({
    projects: [
      {
        id: "p1",
        name: "hoy",
        path: "/tmp/hoy",
        threads: [],
        linear: { teamId: "t1", teamKey: "HOY", teamName: "Hoy" },
        fleet: { queue: [], concurrency: {}, auto: true },
      },
    ],
    subagents: [coder, researcher],
    submitPrompt,
    nonGitProjects: {},
  });
});

test("a ready issue is queued on the named agent and the thread shows the decision", async () => {
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  await Bun.sleep(20);
  const p = useSessionStore.getState().projects[0];
  expect(p.threads[0]?.agent).toBe("Coder");
  expect(submitPrompt).toHaveBeenCalledTimes(1);
  const prompt = submitPrompt.mock.calls[0]![1] as string;
  expect(prompt).toContain("Auto-assigned by the Dispatcher: Implementation work. (confidence 0.90)");
  expect(decisions()["1"].decision.agent).toBe("Coder");
  // No Decision model set: the sidecar picks the cheapest enabled model.
  expect(dispatchDecision.mock.calls[0]![1]).toBeNull();
});

test("the Dispatcher runs on the chosen model and never on a disabled one", async () => {
  usePrefsStore.setState({
    decisionModel: { provider: "meta", id: "muse-spark-1.3" },
    disabledModels: ["meta/muse-spark-1.1"],
  });
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  const call = dispatchDecision.mock.calls[0] as unknown[];
  expect(call[1]).toEqual({ provider: "meta", id: "muse-spark-1.3" });
  expect(call[2]).toEqual(["meta/muse-spark-1.1"]);
  usePrefsStore.setState({ decisionModel: null, disabledModels: [] });
});

test("a not-ready issue gets one comment per revision, never re-decided", async () => {
  dispatchDecision.mockImplementationOnce(async () => ({
    ready: false,
    agent: "Coder",
    confidence: 0.6,
    reason: "Vague.",
    missing: "Say which page is slow.",
  }));
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  for (let i = 0; i < 10; i++) await Bun.sleep(1);
  expect(linearComment).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().projects[0].threads).toHaveLength(0);

  // Same revision: cached, nothing happens on a second pass.
  await useSessionStore.getState().triageAuto("p1");
  expect(dispatchDecision).toHaveBeenCalledTimes(1);
  expect(linearComment).toHaveBeenCalledTimes(1);

  // A revision change re-decides (and re-comments only if still not ready).
  setIssues([issue("1", { updatedAt: "2026-10-20T00:00:00.000Z" })]);
  await useSessionStore.getState().triageAuto("p1");
  for (let i = 0; i < 10; i++) await Bun.sleep(1);
  expect(dispatchDecision).toHaveBeenCalledTimes(2);
});

test("the agent:<Name> label wins and skips the model call", async () => {
  setIssues([issue("1", { labels: ["agent:Researcher"] })]);
  await useSessionStore.getState().triageAuto("p1");
  expect(dispatchDecision).not.toHaveBeenCalled();
  const p = useSessionStore.getState().projects[0];
  expect(p.threads[0]?.agent).toBe("Researcher");
  expect(decisions()["1"].decision.confidence).toBe(1);
});

test("a label naming an unavailable agent holds the issue without a comment", async () => {
  useSessionStore.setState({ subagents: [coder, { ...researcher, enabled: false }] });
  setIssues([issue("1", { labels: ["agent:Researcher"] })]);
  await useSessionStore.getState().triageAuto("p1");
  expect(dispatchDecision).not.toHaveBeenCalled();
  expect(linearComment).not.toHaveBeenCalled();
  expect(useSessionStore.getState().projects[0].threads).toHaveLength(0);
  expect(decisions()["1"].decision.reason).toContain("disabled");
});

test("low confidence holds the issue, showing the reason without a comment", async () => {
  dispatchDecision.mockImplementationOnce(async () => ({
    ready: true,
    agent: "Coder",
    confidence: 0.4,
    reason: "Could be research, could be code.",
  }));
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  expect(linearComment).not.toHaveBeenCalled();
  expect(useSessionStore.getState().projects[0].threads).toHaveLength(0);
  expect(decisions()["1"].decision.reason).toContain("Could be research");
});

test("a dispatcher error holds the issue and never comments on it", async () => {
  dispatchDecision.mockImplementationOnce(async () => {
    throw new Error("sidecar gone");
  });
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  expect(linearComment).not.toHaveBeenCalled();
  expect(decisions()["1"].decision.reason).toContain("dispatcher error");
});

test("a halted agent is not offered to the Dispatcher", async () => {
  const halted = {
    id: "t-halt",
    title: "failed run",
    updatedAt: 0,
    renamed: true,
    agent: "Researcher",
    fleetRun: { startedAt: 1, endedAt: 2, outcome: "error" },
  };
  useSessionStore.setState((s) => ({
    projects: s.projects.map((p) => ({ ...p, threads: [halted] })),
  }));
  setIssues([issue("1")]);
  await useSessionStore.getState().triageAuto("p1");
  const input = dispatchDecision.mock.calls[0]![0] as { agents: Array<{ name: string }> };
  expect(input.agents.map((a) => a.name)).toEqual(["Coder"]);
});

describe("multiple issues", () => {
  test("triages in priority order until the list is empty", async () => {
    setIssues([
      issue("3", { priority: 4 }),
      issue("1", { priority: 1 }),
      issue("2", { priority: 3 }),
    ]);
    await useSessionStore.getState().triageAuto("p1");
    expect(dispatchDecision.mock.calls.map((c) => (c[0] as { issue: { identifier: string } }).issue.identifier)).toEqual([
      "HOY-1",
      "HOY-2",
      "HOY-3",
    ]);
    const p = useSessionStore.getState().projects[0];
    // Concurrency is 1: the first decision starts, the rest wait in the queue.
    expect(p.threads.map((t) => t.linearIssue?.id)).toEqual(["1"]);
    expect(p.fleet!.queue.map((q) => q.issue.id)).toEqual(["2", "3"]);
  });
});

describe("manual decide (the card's Dispatcher button)", () => {
  test("records the verdict and never queues, assigns, or writes", async () => {
    setIssues([issue("1")]);
    await useSessionStore.getState().decideIssue("p1", issue("1"));
    const p = useSessionStore.getState().projects[0];
    expect(p.threads).toHaveLength(0);
    expect(p.fleet!.queue).toHaveLength(0);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(linearComment).not.toHaveBeenCalled();
    const d = decisions()["1"];
    expect(d.decision.agent).toBe("Coder");
    // Seen by the user: a later Auto pass neither re-decides nor nags.
    expect(d.naggedAt).toBe(issue("1").updatedAt);
  });

  test("Auto queues a ready verdict once per revision, and unqueueing it sticks", async () => {
    setIssues([issue("1"), issue("2")]);
    useSessionStore.setState((s) => ({
      projects: s.projects.map((p) => ({ ...p, fleet: { ...p.fleet!, auto: false } })),
    }));
    await useSessionStore.getState().decideIssue("p1", issue("2"));
    useSessionStore.setState((s) => ({
      projects: s.projects.map((p) => ({ ...p, fleet: { ...p.fleet!, auto: true } })),
    }));
    await useSessionStore.getState().triageAuto("p1");
    // HOY-1 takes the free slot; the cached HOY-2 verdict queues without a new call.
    expect(dispatchDecision).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().projects[0].fleet!.queue.map((q) => q.issue.id)).toEqual(["2"]);
    expect(decisions()["2"].queuedAt).toBe(issue("2").updatedAt);

    useSessionStore.getState().unqueueIssue("p1", "2");
    await useSessionStore.getState().triageAuto("p1");
    expect(useSessionStore.getState().projects[0].fleet!.queue).toHaveLength(0);
    expect(dispatchDecision).toHaveBeenCalledTimes(2);
  });

  test("a manual not-ready verdict never posts the missing note, even under Auto", async () => {
    dispatchDecision.mockImplementationOnce(async () => ({
      ready: false,
      agent: "Coder",
      confidence: 0.6,
      reason: "Vague.",
      missing: "Say which page is slow.",
    }));
    setIssues([issue("1")]);
    await useSessionStore.getState().decideIssue("p1", issue("1"));
    await useSessionStore.getState().triageAuto("p1");
    expect(linearComment).not.toHaveBeenCalled();
    expect(dispatchDecision).toHaveBeenCalledTimes(1);
  });

  test("the agent:<Name> label still wins and skips the model call", async () => {
    const labeled = issue("1", { labels: ["agent:Researcher"] });
    setIssues([labeled]);
    await useSessionStore.getState().decideIssue("p1", labeled);
    expect(dispatchDecision).not.toHaveBeenCalled();
    expect(decisions()["1"].decision.agent).toBe("Researcher");
    expect(useSessionStore.getState().projects[0].threads).toHaveLength(0);
  });

  test("a dispatcher error records as a hold, no comment", async () => {
    dispatchDecision.mockImplementationOnce(async () => {
      throw new Error("sidecar gone");
    });
    setIssues([issue("1")]);
    await useSessionStore.getState().decideIssue("p1", issue("1"));
    expect(linearComment).not.toHaveBeenCalled();
    expect(decisions()["1"].decision.reason).toContain("dispatcher error");
  });
});
