import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LinearIssue, Thread } from "@/lib/types";
import { mockIpcModule } from "./ipcMock";

mockIpcModule();

const { useSessionStore, threadCwd } = await import("@/state/store");
const { issueBranch, issuePrompt } = await import("@/lib/delegate");
// The live mocks: bun shares module mocks across files.
type M = ReturnType<typeof mock>;
const ipc = (await import("@/lib/ipc")) as unknown as Record<string, M>;

const flush = () => Bun.sleep(5);

function issue(n: string, extra: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: `i${n}`,
    identifier: `HOY-${n}`,
    title: `Fix the login bug ${n}`,
    description: null,
    url: `https://linear.app/hoy/issue/HOY-${n}`,
    priority: 2,
    priorityLabel: "High",
    estimate: null,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
    ...extra,
  };
}

function seed(threads: Thread[] = []) {
  useSessionStore.setState({
    projects: [{ id: "p1", name: "hoy", path: "/repo", threads }],
    panels: [],
    turns: {},
    streaming: {},
    threadErrors: {},
    subagents: [],
    nonGitProjects: {},
  });
}
const thread = () => useSessionStore.getState().projects[0].threads[0];

describe("issue branches", () => {
  test("use Linear's branch name, else hoy/<id>-<title words>", () => {
    expect(issueBranch(issue("1", { branchName: "acid/hoy-1-login" }))).toBe("acid/hoy-1-login");
    expect(issueBranch(issue("12"))).toBe("hoy/hoy-12-fix-the-login-bug-12");
  });
});

describe("dispatching into a worktree (HOY-358)", () => {
  const realSubmit = useSessionStore.getState().submitPrompt;
  beforeEach(() => {
    seed();
    for (const k of ["projectIsGitRepo", "createIssueWorktree", "removeIssueWorktree"]) ipc[k].mockClear();
    useSessionStore.setState({ submitPrompt: realSubmit });
  });

  test("a git project gets a worktree before the brief, and the brief names it", async () => {
    const submitPrompt = mock(async () => {});
    useSessionStore.setState({ submitPrompt });
    ipc.projectIsGitRepo.mockImplementation(async () => true);
    ipc.createIssueWorktree.mockImplementation(async () => ({ path: "/wt/hoy-3", branch: "hoy/hoy-3-x", base: "main" }));
    useSessionStore.getState().delegateIssue("p1", issue("3"), "Coder");
    await flush();
    expect(ipc.createIssueWorktree).toHaveBeenCalledWith("/repo", issueBranch(issue("3")));
    expect(thread().worktree).toEqual({ path: "/wt/hoy-3", branch: "hoy/hoy-3-x", base: "main" });
    const brief = (submitPrompt.mock.calls[0] as unknown[])[1] as string;
    expect(brief).toBe(issuePrompt(issue("3"), "Coder", thread().worktree));
    expect(brief).toContain("branch hoy/hoy-3-x created from main");
  });

  test("a worktree that cannot be created ends the run instead of using the checkout", async () => {
    const submitPrompt = mock(async () => {});
    useSessionStore.setState({ submitPrompt });
    ipc.projectIsGitRepo.mockImplementation(async () => true);
    ipc.createIssueWorktree.mockImplementation(async () => {
      throw new Error("branch exists elsewhere");
    });
    useSessionStore.getState().delegateIssue("p1", issue("4"), "Coder");
    await flush();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(thread().fleetRun?.outcome).toBe("error");
    expect(useSessionStore.getState().threadErrors[thread().id]).toContain("Could not create a worktree");
  });

  test("a non-git project runs in its folder and is marked for one run at a time", async () => {
    const submitPrompt = mock(async () => {});
    useSessionStore.setState({ submitPrompt });
    ipc.projectIsGitRepo.mockImplementation(async () => false);
    useSessionStore.getState().delegateIssue("p1", issue("5"), "Coder");
    await flush();
    expect(ipc.createIssueWorktree).not.toHaveBeenCalled();
    expect(useSessionStore.getState().nonGitProjects.p1).toBe(true);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });
});

describe("where sessions run", () => {
  test("a delegated thread uses its worktree and its subagents inherit it", () => {
    const wt = { path: "/wt/a", branch: "b", base: "main" };
    const threads: Thread[] = [
      { id: "t1", title: "a", updatedAt: 0, sessionId: null, worktree: wt },
      { id: "t2", title: "child", updatedAt: 0, sessionId: null, parentThreadId: "t1" },
      { id: "t3", title: "plain", updatedAt: 0, sessionId: null },
      { id: "t4", title: "done", updatedAt: 0, sessionId: null, worktree: { ...wt, removed: true } },
    ];
    const projects = [{ id: "p1", name: "hoy", path: "/repo", threads }];
    expect(threadCwd(projects, "t1")).toBe("/wt/a");
    expect(threadCwd(projects, "t2")).toBe("/wt/a");
    expect(threadCwd(projects, "t3")).toBe("/repo");
    expect(threadCwd(projects, "t4")).toBe("/repo");
  });
});

describe("archiving a delegated thread", () => {
  const wt = { path: "/wt/a", branch: "b", base: "main" };
  beforeEach(() => {
    seed([{ id: "t1", title: "a", updatedAt: 1, sessionId: null, sessionFile: "/s.jsonl", worktree: wt }]);
    ipc.removeIssueWorktree.mockClear();
  });

  test("removes the worktree, keeps its record, then archives", async () => {
    ipc.removeIssueWorktree.mockImplementation(async () => ({ removed: true, dirty: false }));
    useSessionStore.getState().archiveThread("t1");
    await flush();
    expect(ipc.removeIssueWorktree).toHaveBeenCalledWith("/repo", "/wt/a", false);
    expect(thread().worktree).toEqual({ ...wt, removed: true });
    expect(thread().archived).toBe(true);
  });

  test("uncommitted changes keep the thread on its row until forced", async () => {
    ipc.removeIssueWorktree.mockImplementation(async (_p: string, _w: string, force: boolean) =>
      force ? { removed: true, dirty: true } : { removed: false, dirty: true },
    );
    useSessionStore.getState().archiveThread("t1");
    await flush();
    expect(thread().archived).toBeFalsy();
    expect(thread().worktreeIssue).toContain("uncommitted changes");
    await useSessionStore.getState().archiveDelegated("t1", true);
    expect(thread().archived).toBe(true);
    expect(thread().worktreeIssue).toBeNull();
  });
});

describe("how delegated work ends (HOY-359)", () => {
  const wt = { path: "/wt/hoy-7", branch: "hoy/hoy-7-x", base: "main" };

  test("a worktree run commits on its branch, references the issue, and does not push by default", () => {
    const brief = issuePrompt(issue("7"), "Coder", wt);
    expect(brief).toContain("commit on hoy/hoy-7-x with a Conventional Commit message that references HOY-7");
    expect(brief).toContain("Do not push the branch or open a pull request");
    expect(brief).toContain("In Review");
  });

  test("with pull requests on, it pushes and opens one against the base", () => {
    const brief = issuePrompt(issue("7"), "Coder", wt, { openPullRequests: true });
    expect(brief).toContain("git push -u origin hoy/hoy-7-x");
    expect(brief).toContain("gh pr create");
    expect(brief).toContain("against main");
    expect(brief).not.toContain("Do not push");
  });

  test("without a worktree the brief has no commit step", () => {
    expect(issuePrompt(issue("7"), "Coder")).not.toContain("commit on");
  });

  test("the pull request URL is found in replies or tool output, last one wins", async () => {
    const { findPullRequestUrl } = await import("@/lib/delegate");
    const tool = (output: string) => ({
      kind: "tool" as const,
      tool: { id: "x", name: "bash", title: "bash", running: false, output } as never,
    });
    expect(
      findPullRequestUrl([
        { role: "user", text: "https://github.com/a/b/pull/1" },
        { role: "assistant", blocks: [tool("https://github.com/acme/app/pull/12\n")] },
        { role: "assistant", blocks: [{ kind: "text", content: "Opened https://github.com/acme/app/pull/13." }] },
      ] as never),
    ).toBe("https://github.com/acme/app/pull/13");
    expect(findPullRequestUrl([{ role: "assistant", blocks: [{ kind: "text", content: "no link" }] }] as never)).toBeNull();
  });

  test("the setting is per project and keeps the rest of the fleet", () => {
    useSessionStore.setState({
      projects: [{ id: "p1", name: "hoy", path: "/repo", threads: [], fleet: { queue: [], concurrency: { Coder: 2 } } }],
    });
    useSessionStore.getState().setOpenPullRequests("p1", true);
    expect(useSessionStore.getState().projects[0].fleet).toEqual({
      queue: [],
      concurrency: { Coder: 2 },
      openPullRequests: true,
    });
  });
});
