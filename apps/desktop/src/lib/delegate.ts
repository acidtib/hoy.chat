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

// The first prompt a delegated thread receives. NUL is stripped because the
// composer draft format uses it to delimit mention markers.
export function issuePrompt(issue: LinearIssue): string {
  const lines = [
    `Work on Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
  ];
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.description) lines.push("", issue.description);
  lines.push(
    "",
    `When you are done, post a short summary on ${issue.identifier} with linear_comment (what changed, how you verified it, anything left open), then move it with linear_set_state. File anything out of scope as a follow-up with linear_create_issue.`,
  );
  return lines.join("\n").replaceAll("\u0000", "");
}
