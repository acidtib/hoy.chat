import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockIpcModule } from "./ipcMock";

const createSession = mock(async () => "s-talk");
mockIpcModule({
  createSession,
  readSessionTranscript: mock(async () => []),
  getMessages: mock(async () => []),
  getState: mock(async () => ({})),
});

const { isInteractiveAgentThread, talkToAgentDraft } = await import("@/lib/delegate");
const { useSessionStore } = await import("@/state/store");

import type { LinearIssue, Thread } from "@/lib/types";

function issue(): LinearIssue {
  return {
    id: "i1",
    identifier: "HOY-12",
    title: "Fix the thing",
    description: null,
    url: "https://linear.app/hoy/issue/HOY-12",
    priority: 2,
    priorityLabel: "",
    estimate: null,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
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

beforeEach(() => {
  createSession.mockClear();
  useSessionStore.setState({
    projects: [{ id: "p1", name: "hoy", path: "/tmp/hoy", threads: [] }],
    panels: [],
    activeThreadId: null,
    turns: {},
    streaming: {},
    drafts: {},
    subagents: [],
  });
});

describe("startAgentThread", () => {
  test("creates a blank untitled thread running as the agent, not a Fleet run", () => {
    const id = useSessionStore.getState().startAgentThread("p1", "Coder");
    const t = useSessionStore.getState().projects[0].threads[0];
    expect(t.id).toBe(id!);
    expect(t.agent).toBe("Coder");
    expect(t.fleetRun).toBeUndefined();
    expect(t.permissionMode).toBeUndefined();
    expect(t.title).toBe("New thread");
    expect(t.renamed).toBeUndefined();
    expect(useSessionStore.getState().drafts[id!]).toBeUndefined();
    expect(isInteractiveAgentThread(t)).toBe(true);
  });

  test("from a run copies the worktree and prefills the issue and report", () => {
    const i = issue();
    useSessionStore.setState((s) => ({
      projects: [
        {
          id: "p1",
          name: "hoy",
          path: "/tmp/hoy",
          threads: [
            thread("run1", {
              agent: "Coder",
              linearIssue: ref(i),
              fleetRun: { startedAt: 1, endedAt: 2, outcome: "done" },
              worktree: { path: "/tmp/wt", branch: "hoy/hoy-12-fix", base: "main" },
            }),
          ],
        },
      ],
      turns: {
        run1: [
          { role: "user", text: "do it" },
          {
            role: "assistant",
            blocks: [{ kind: "text", content: "Fixed it and committed." }],
            streaming: false,
          },
        ],
      },
    }));
    const id = useSessionStore
      .getState()
      .startAgentThread("p1", "Coder", { fromRunThreadId: "run1" });
    const t = useSessionStore.getState().projects[0].threads.find((x) => x.id === id!);
    expect(t!.title).toBe("Talk to Coder");
    expect(t!.agent).toBe("Coder");
    expect(t!.fleetRun).toBeUndefined();
    expect(t!.worktree).toEqual({ path: "/tmp/wt", branch: "hoy/hoy-12-fix", base: "main" });
    const draft = useSessionStore.getState().drafts[id!];
    expect(draft).toContain("HOY-12");
    expect(draft).toContain("Fixed it and committed.");
    expect(draft).toContain("hoy/hoy-12-fix");
    expect(isInteractiveAgentThread(t!)).toBe(true);
  });

  test("talkToAgentDraft omits empty sections", () => {
    expect(talkToAgentDraft("Coder", null, "", null)).toBe("\n");
  });
});

describe("interactiveAgent session flag", () => {
  test("hydrateThread marks an interactive agent thread, not a delegated run", async () => {
    const i = issue();
    useSessionStore.setState({
      projects: [
        {
          id: "p1",
          name: "hoy",
          path: "/tmp/hoy",
          threads: [
            thread("t-talk", { agent: "Coder", sessionFile: "/tmp/a.jsonl" }),
            thread("t-run", {
              agent: "Coder",
              linearIssue: ref(i),
              fleetRun: { startedAt: 1 },
              sessionFile: "/tmp/b.jsonl",
            }),
          ],
        },
      ],
    });
    await useSessionStore.getState().hydrateThread("t-talk");
    expect(createSession).toHaveBeenCalled();
    expect(createSession.mock.calls[0][2]).toBe("Coder");
    expect(createSession.mock.calls[0][7]).toBe(true);

    createSession.mockClear();
    await useSessionStore.getState().hydrateThread("t-run");
    expect(createSession).toHaveBeenCalled();
    expect(createSession.mock.calls[0][7]).toBe(false);
  });
});
