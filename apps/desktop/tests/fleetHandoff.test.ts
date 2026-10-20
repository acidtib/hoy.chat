import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

let commentIds = 0;
const linearComment = mock(async (..._args: unknown[]) => `c${++commentIds}`);
const linearSetIssueState = mock(async (..._args: unknown[]) => {});
const createIssueWorktree = mock(async (_path: string, branch: string) => ({
  path: `/w/${branch}`,
  branch,
  base: "main",
}));
const removeIssueWorktree = mock(async () => ({ removed: true, dirty: false }));
const dispatchDecision = mock(async (..._args: unknown[]) => ({
  ready: true,
  agent: "Researcher",
  confidence: 0.9,
  reason: "Needs an investigation first.",
  cost: 0.001,
}));
mockIpcModule({
  loadWorkspace: mock(async () => ({ projects: [] })),
  listSubagents: mock(async () => []),
  projectIsGitRepo: mock(async () => true),
  linearComment,
  linearSetIssueState,
  createIssueWorktree,
  removeIssueWorktree,
  dispatchDecision,
});

const { useSessionStore } = await import("@/state/store");
import type { LinearIssue, SubagentDef, Thread } from "@/lib/types";

const issue: LinearIssue = {
  id: "i1",
  identifier: "HOY-1",
  title: "Add a toggle",
  description: "In Settings.",
  url: "https://linear.app/x/HOY-1",
  priority: 2,
  priorityLabel: "High",
  estimate: null,
  stateName: "Todo",
  stateType: "unstarted",
  assignee: null,
  labels: [],
  branchName: "hoy-1-add-a-toggle",
};

const def = (name: string) => ({ name, enabled: true }) as SubagentDef;
const submitPrompt = mock(async (..._args: unknown[]) => {});
const project = () => useSessionStore.getState().projects[0];
// Newest first, like the store keeps them.
const runsOf = (agent: string) => project().threads.filter((t) => t.agent === agent);
const lastPrompt = () => submitPrompt.mock.calls.at(-1)![1] as string;

const text = (content: string) => ({ kind: "text", content });
const tool = (name: string, output: string) => ({
  kind: "tool",
  tool: { id: name, name, title: name, output, running: false },
});
const movedTo = (state: string) => tool("linear_set_state", JSON.stringify({ identifier: "HOY-1", state }));

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(1);
}

// A run ends when its thread stops streaming; the watcher then settles async.
async function endRun(thread: Thread, blocks: unknown[], extra: Record<string, unknown> = {}) {
  useSessionStore.setState((s) => ({ streaming: { ...s.streaming, [thread.id]: true } }));
  useSessionStore.setState((s) => ({
    turns: { ...s.turns, [thread.id]: [{ role: "assistant", blocks, ...extra }] },
    streaming: { ...s.streaming, [thread.id]: false },
  }));
  await settle();
}

async function start(agent: string) {
  useSessionStore.getState().enqueueIssue("p1", issue, agent);
  await settle();
  return runsOf(agent)[0];
}

const setAuto = (auto: boolean) =>
  useSessionStore.setState((s) => ({
    projects: s.projects.map((p) => ({ ...p, fleet: { ...p.fleet!, auto } })),
  }));

const realSubmitPrompt = useSessionStore.getState().submitPrompt;
beforeAll(async () => {
  await useSessionStore.getState().initWorkspace();
});
afterAll(() => useSessionStore.setState({ submitPrompt: realSubmitPrompt }));

beforeEach(() => {
  commentIds = 0;
  for (const m of [linearComment, linearSetIssueState, createIssueWorktree, removeIssueWorktree, dispatchDecision, submitPrompt]) {
    m.mockClear();
  }
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
    subagents: ["Architect", "Coder", "Reviewer", "Researcher"].map(def),
    submitPrompt,
    nonGitProjects: {},
    panels: [],
    turns: {},
    streaming: {},
    threadErrors: {},
  });
});

test("Coder to Reviewer to Coder on Fix first, in one worktree, with threaded notes", async () => {
  const coder = await start("Coder");
  await endRun(coder, [text("Committed."), movedTo("In Review")]);

  const reviewer = runsOf("Reviewer")[0];
  expect(reviewer.handoff).toMatchObject({ fromAgent: "Coder", by: "rule", round: 0, hops: 1 });
  expect(createIssueWorktree.mock.calls.map((c) => c[1])).toEqual(["hoy-1-add-a-toggle", "hoy-1-add-a-toggle"]);
  expect(lastPrompt()).toContain("Review the change on branch hoy-1-add-a-toggle");
  expect(lastPrompt()).toContain("Leave the issue's state as it is");
  // The review leaves the issue in review: only the Coder's start moved it.
  expect(linearSetIssueState).toHaveBeenCalledTimes(1);
  expect(linearComment.mock.calls[0]!.slice(1)).toEqual([expect.stringContaining("Handed from Coder to Reviewer"), null]);
  expect(project().fleet!.chainComments).toEqual({ i1: "c1" });

  await endRun(reviewer, [text("Verdict: Fix first\n\n1. high, a.ts:3, off by one.")]);
  const fix = runsOf("Coder")[0];
  expect(fix.handoff).toMatchObject({ fromAgent: "Reviewer", round: 1, hops: 2 });
  expect(lastPrompt()).toContain("Fix the review findings below");
  expect(lastPrompt()).toContain("a.ts:3, off by one.");
  expect(linearComment.mock.calls[1]![2]).toBe("c1");
});

test("two Fix first rounds stop the chain for the user", async () => {
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")]);
  for (let round = 1; round <= 2; round++) {
    await endRun(runsOf("Reviewer")[0], [text("Verdict: Fix first")]);
    await endRun(runsOf("Coder")[0], [movedTo("In Review")]);
  }
  await endRun(runsOf("Reviewer")[0], [text("Verdict: Fix first")]);
  expect(runsOf("Coder")).toHaveLength(3);
  expect(runsOf("Reviewer")[0].chainStop).toMatchObject({ needsUser: true });
  expect(project().fleet!.queue).toHaveLength(0);
});

test("Ship ends the chain without asking the user", async () => {
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")]);
  await endRun(runsOf("Reviewer")[0], [text("Verdict: Ship")]);
  expect(runsOf("Reviewer")[0].chainStop).toEqual({ reason: "Review says ship.", needsUser: false });
  expect(runsOf("Coder")).toHaveLength(1);
});

test("a stopped run never hands off", async () => {
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")], { aborted: true, error: "Request was aborted" });
  expect(runsOf("Reviewer")).toHaveLength(0);
  expect(linearComment).not.toHaveBeenCalled();
});

test("an agent's reroute with no name asks the Dispatcher, with its report", async () => {
  const coder = await start("Coder");
  const reroute = tool("fleet_handoff", '{"handoff":{"agent":null,"reason":"Only asks a question."}}\nHanded off.');
  await endRun(coder, [reroute, text("Not code work; handing off.")]);
  const input = dispatchDecision.mock.calls[0]![0] as { previous: { agent: string; report: string }; agents: { name: string }[] };
  expect(input.previous).toEqual({ agent: "Coder", report: "Not code work; handing off." });
  expect(input.agents.map((a) => a.name)).not.toContain("Coder");
  expect(runsOf("Researcher")[0].handoff).toMatchObject({ by: "agent", reason: "Needs an investigation first." });
  expect(project().fleet!.dispatchSpend).toBe(0.001);
});

test("an unsure Dispatcher stops the chain for the user", async () => {
  dispatchDecision.mockImplementationOnce(async () => ({
    ready: true,
    agent: "Researcher",
    confidence: 0.4,
    reason: "Unclear what is left.",
    cost: 0,
  }));
  const researcher = await start("Researcher");
  await endRun(researcher, [text("Findings.")]);
  expect(runsOf("Researcher")[0].chainStop).toEqual({ reason: "Unclear what is left.", needsUser: true });
});

test("with Auto off the next step is offered, and accepting it hands off", async () => {
  setAuto(false);
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")]);
  expect(runsOf("Reviewer")).toHaveLength(0);
  expect(runsOf("Coder")[0].nextStep).toMatchObject({ agent: "Reviewer", by: "rule" });

  useSessionStore.getState().acceptNextStep(coder.id);
  await settle();
  expect(runsOf("Reviewer")).toHaveLength(1);
  expect(runsOf("Coder")[0].nextStep).toBeNull();
  expect(runsOf("Coder")[0].handedTo).toBe("Reviewer");
});

test("handing off a live run stops it without halting its agent's queue", async () => {
  const coder = await start("Coder");
  const stopStreaming = mock(async (id: string) => {
    useSessionStore.setState((s) => ({
      turns: { ...s.turns, [id]: [{ role: "assistant", blocks: [], aborted: true, error: "Request was aborted" }] },
      streaming: { ...s.streaming, [id]: false },
    }));
  });
  useSessionStore.setState((s) => ({ stopStreaming, streaming: { ...s.streaming, [coder.id]: true } }));
  await useSessionStore.getState().handOffThread(coder.id, "Architect");
  await settle();
  const moved = runsOf("Coder")[0];
  expect(stopStreaming).toHaveBeenCalledTimes(1);
  expect(moved.fleetRun).toMatchObject({ outcome: "stopped", acknowledged: true });
  expect(runsOf("Architect")[0].handoff).toMatchObject({ by: "user", fromAgent: "Coder" });
});

test("archiving an earlier run keeps the worktree a later run still uses", async () => {
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")]);
  await useSessionStore.getState().archiveDelegated(coder.id);
  expect(removeIssueWorktree).not.toHaveBeenCalled();
  expect(runsOf("Coder")[0].archived).toBe(true);
});

test("moving a queued issue keeps its handoff and starts it on the new agent", async () => {
  const coder = await start("Coder");
  await endRun(coder, [movedTo("In Review")]);
  // Reviewer is busy, so a second handoff waits in its queue.
  useSessionStore.setState((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      fleet: {
        ...p.fleet!,
        queue: [{ agent: "Reviewer", issue: { ...issue, id: "i2", identifier: "HOY-2" }, queuedAt: 0, handoff: runsOf("Reviewer")[0].handoff }],
      },
    })),
  }));
  useSessionStore.getState().moveQueuedTo("p1", "i2", "Architect");
  await settle();
  const moved = runsOf("Architect")[0];
  expect(moved.linearIssue?.identifier).toBe("HOY-2");
  expect(moved.handoff).toMatchObject({ fromAgent: "Coder" });
  expect(project().fleet!.queue).toHaveLength(0);
});
