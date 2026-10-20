// Pure helpers for the Delegate board (HOY-346).

import type { LinearIssue, QueuedIssue, Thread } from "./types";

// Issues not yet handed to an agent in this project, running or queued. An
// archived delegated thread releases its issue back to the column.
export function unassignedIssues(
  issues: LinearIssue[],
  threads: Thread[],
  queue: QueuedIssue[] = [],
): LinearIssue[] {
  const taken = new Set([
    ...threads
      .filter((t) => !t.archived && t.linearIssue)
      .map((t) => t.linearIssue!.id),
    ...queue.map((q) => q.issue.id),
  ]);
  return issues
    .filter((i) => !taken.has(i.id))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

// Linear's 0 means "no priority", which sorts after low (4).
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

// Everything an agent type is working on in a project, newest first: issues
// delegated to it and subagents of that type spawned by other threads.
export function agentThreads(threads: Thread[], agent: string): Thread[] {
  return threads
    .filter(
      (t) => !t.archived && (t.agent === agent || t.spawnedBy?.type === agent),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// What each built-in role does with an issue it is handed (HOY-366). Custom
// agents get the generic line.
const ISSUE_ASK: Record<string, string> = {
  Researcher: "Investigate the question in this issue and report your findings.",
  Architect: "Design the implementation plan for this issue. Do not implement it.",
  Coder: "Implement this issue.",
  Tester: "Write and run the tests this issue calls for. Do not change production code unless the issue asks you to.",
  Reviewer:
    "Review the change for this issue: find its pull request or branch (linked in the issue, or with gh pr list --search) and review it. Do not change the code.",
  Writer: "Write the document this issue asks for.",
  "Project Manager":
    "Break this issue down: file sub-issues an agent can each finish in one run, with dependencies and a suggested agent for each.",
  "Security Reviewer": "Review the code this issue covers for security problems. Do not change the code.",
  DevOps: "Do the build or pipeline work this issue asks for. Do not push, publish, or deploy.",
  Frontend: "Implement the UI work in this issue.",
};

// The first prompt a delegated thread receives. NUL is stripped because the
// composer draft format uses it to delimit mention markers.
// The branch a delegated issue works on: Linear's suggestion, else one built
// from the identifier and title.
export function issueBranch(issue: LinearIssue): string {
  if (issue.branchName?.trim()) return issue.branchName.trim();
  const words = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return `hoy/${issue.identifier.toLowerCase()}${words ? `-${words}` : ""}`;
}

export function issuePrompt(
  issue: LinearIssue,
  agent?: string,
  worktree?: { path: string; branch: string; base: string } | null,
): string {
  const lines = [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
  ];
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.description) lines.push("", issue.description);
  lines.push(
    "",
    (agent && ISSUE_ASK[agent]) ?? "Work on this issue.",
    ...(worktree
      ? [
          "",
          `You are working in a dedicated git worktree at ${worktree.path}, on branch ${worktree.branch} created from ${worktree.base}. Other agents work in their own worktrees, so keep every change here. Dependencies may not be installed in this worktree; install them with the project's package manager if its checks need them.`,
        ]
      : []),
    "",
    `When you are done, post your report on ${issue.identifier} with linear_comment, then move it with linear_set_state. File anything out of scope as a follow-up with linear_create_issue.`,
  );
  return lines.join("\n").replaceAll("\u0000", "");
}
