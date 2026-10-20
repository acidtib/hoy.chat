import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

const createSession = mock(async () => "s-delegate");
const linearSetIssueState = mock(async () => {});
const calls: string[] = [];
const setPermissionMode = mock(async (_s: string, mode: string) => {
  calls.push(`mode:${mode}`);
});
const sendPrompt = mock(async () => {
  calls.push("prompt");
});
mockIpcModule({
  createSession,
  linearSetIssueState,
  setPermissionMode,
  sendPrompt,
  readSessionTranscript: mock(async () => []),
  getMessages: mock(async () => []),
  getState: mock(async () => ({})),
});

const { agentThreads, issuePrompt, unassignedIssues } = await import("@/lib/delegate");
const { useSessionStore } = await import("@/state/store");

import type { LinearIssue, Thread } from "@/lib/types";

function issue(id: string, priority: number, extra: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id,
    identifier: `HOY-${id}`,
    title: `Issue ${id}`,
    description: null,
    url: `https://linear.app/hoy/issue/HOY-${id}`,
    priority,
    priorityLabel: "",
    estimate: null,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
    ...extra,
  };
}

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, title: id, updatedAt: 0, sessionId: null, ...extra };
}

const ref = (i: LinearIssue) => ({
  id: i.id,
  identifier: i.identifier,
  title: i.title,
  url: i.url,
});

describe("unassignedIssues", () => {
  test("hides delegated issues and sorts urgent first, no priority last", () => {
    const a = issue("1", 0);
    const b = issue("2", 3);
    const c = issue("3", 1);
    const d = issue("4", 2);
    const threads = [thread("t1", { linearIssue: ref(d), agent: "Explore" })];
    expect(unassignedIssues([a, b, c, d], threads).map((i) => i.id)).toEqual([
      "3",
      "2",
      "1",
    ]);
  });

  test("an archived delegated thread releases its issue", () => {
    const a = issue("1", 2);
    const threads = [thread("t1", { linearIssue: ref(a), archived: true })];
    expect(unassignedIssues([a], threads)).toHaveLength(1);
  });
});

test("agentThreads lists an agent's delegated and spawned work, newest first", () => {
  const a = issue("1", 2);
  const threads = [
    thread("old", { agent: "Explore", linearIssue: ref(a), updatedAt: 1 }),
    thread("new", { agent: "Explore", linearIssue: ref(a), updatedAt: 3 }),
    thread("spawned", {
      parentThreadId: "p",
      spawnedBy: { type: "Explore", agentId: "a1" },
      updatedAt: 2,
    }),
    thread("other", { agent: "Plan", linearIssue: ref(a) }),
    thread("plain"),
    thread("gone", { agent: "Explore", linearIssue: ref(a), archived: true }),
  ];
  expect(agentThreads(threads, "Explore").map((t) => t.id)).toEqual([
    "new",
    "spawned",
    "old",
  ]);
});

test("issuePrompt carries the issue and strips NUL mention delimiters", () => {
  const text = issuePrompt(
    issue("7", 2, { description: "Steps\u0000here", labels: ["Bug", "Web"] }),
  );
  expect(text).toContain("Linear issue HOY-7: Issue 7");
  expect(text).toContain("Work on this issue.");
  expect(text).toContain("https://linear.app/hoy/issue/HOY-7");
  expect(text).toContain("Labels: Bug, Web");
  expect(text).toContain("Stepshere");
  expect(text).not.toContain("\u0000");
  expect(text).toContain("linear_comment");
  expect(text).toContain("linear_set_state");
});

test("issuePrompt tells each role what to do with the issue", () => {
  const i = issue("8", 2);
  expect(issuePrompt(i, "Reviewer")).toContain("Do not change the code.");
  expect(issuePrompt(i, "Architect")).toContain("Do not implement it.");
  expect(issuePrompt(i, "Project Manager")).toContain("file sub-issues");
  expect(issuePrompt(i, "My Agent")).toContain("Work on this issue.");
});

test("Architect posts the full plan and leaves the state for the Fleet", () => {
  const p = issuePrompt(issue("8", 2), "Architect");
  expect(p).toContain("post the full plan on HOY-8 with linear_comment, not a summary");
  expect(p).toContain("Leave the issue's state as it is");
  expect(p).not.toContain("linear_set_state");
});

describe("delegateIssue", () => {
  const realSubmitPrompt = useSessionStore.getState().submitPrompt;
  afterEach(() => useSessionStore.setState({ submitPrompt: realSubmitPrompt }));
  beforeEach(() => {
    createSession.mockClear();
    useSessionStore.setState({
      projects: [{ id: "p1", name: "hoy", path: "/tmp/hoy", threads: [] }],
      panels: [],
      activeThreadId: null,
      turns: {},
      streaming: {},
      subagents: [],
    });
  });

  test("creates a titled thread running as the agent and prompts it with the issue", async () => {
    const submitPrompt = mock(async () => {});
    useSessionStore.setState({ submitPrompt });
    const i = issue("9", 2);
    const id = useSessionStore.getState().delegateIssue("p1", i, "Explore");
    for (let n = 0; n < 20 && submitPrompt.mock.calls.length === 0; n++) await Bun.sleep(5);

    const t = useSessionStore.getState().projects[0].threads[0];
    expect(t.id).toBe(id!);
    expect(t.title).toBe("HOY-9 Issue 9");
    expect(t.agent).toBe("Explore");
    expect(t.linearIssue).toEqual(ref(i));
    expect(t.renamed).toBe(true);
    expect(t.permissionMode).toBe("autonomous");
    expect(submitPrompt.mock.calls[0][0]).toBe(t.id);
    expect(submitPrompt.mock.calls[0][1]).toBe(issuePrompt(i, "Explore"));
    expect(linearSetIssueState).toHaveBeenCalledWith(i.id, "started");
  });

  test("the session is autonomous before the issue prompt is sent", async () => {
    calls.length = 0;
    const id = useSessionStore.getState().delegateIssue("p1", issue("5", 2), "Explore");
    for (let i = 0; i < 20 && !calls.includes("prompt"); i++) await Bun.sleep(5);
    expect(useSessionStore.getState().projects[0].threads[0].id).toBe(id!);
    expect(calls).toEqual(["mode:autonomous", "prompt"]);
  });

  test("spawning the thread's session passes its agent type", async () => {
    useSessionStore.setState({
      projects: [
        {
          id: "p1",
          name: "hoy",
          path: "/tmp/hoy",
          threads: [
            thread("t-agent", {
              agent: "Explore",
              sessionFile: "/tmp/s.jsonl",
              linearIssue: ref(issue("1", 2)),
            }),
          ],
        },
      ],
    });
    await useSessionStore.getState().hydrateThread("t-agent");
    expect(createSession).toHaveBeenCalled();
    expect(createSession.mock.calls[0][2]).toBe("Explore");
  });
});
