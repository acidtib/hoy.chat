// Pure helpers for the Delegate board (HOY-346).

import type { DispatchDecision, Handoff, LinearIssue, QueuedIssue, Thread, Turn } from "./types";

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
    "Review the change for this issue: find its pull request or branch (linked in the issue, or with gh pr list --search) and review it. Do not change the code. End your final reply with the Verdict line.",
  Writer: "Write the document this issue asks for.",
  "Project Manager":
    "Break this issue down: file sub-issues an agent can each finish in one run, with dependencies and a suggested agent for each.",
  "Security Reviewer": "Review the code this issue covers for security problems. Do not change the code.",
  DevOps: "Do the build or pipeline work this issue asks for. Do not push, publish, or deploy.",
  Frontend: "Implement the UI work in this issue.",
};

// HOY-379: what a handed-off run is asked, when it differs from the role's usual ask.
function handoffAsk(agent: string | undefined, handoff: Handoff, branch?: string): string | null {
  if (agent === "Coder" && handoff.fromAgent === "Reviewer") {
    return "Fix the review findings below on the same branch. Leave anything the review did not ask for.";
  }
  if (agent === "Coder" && handoff.fromAgent === "Architect") return "Implement the plan below.";
  if (agent === "Reviewer" && branch) {
    return `Review the change on branch ${branch} in this worktree (git diff against its base). Do not change the code. End your final reply with the Verdict line.`;
  }
  return null;
}

// Roles whose run is not the last step: the Fleet moves the issue on, not them.
const KEEPS_STATE = new Set(["Architect", "Reviewer"]);

// HOY-359: how delegated work ends. Committing on the issue branch is what the
// brief asks for; pushing and a pull request only when the project allows it.
function finishSteps(
  id: string,
  worktree: { branch: string; base: string },
  openPullRequests: boolean,
): string[] {
  const steps = [
    `If you changed files: run the project's checks, then commit on ${worktree.branch} with a Conventional Commit message that references ${id} (for example \`fix(scope): what changed\` with \`Refs ${id}\` in the body), following the repository's commit conventions if it documents them. This brief is your instruction to commit; never commit on another branch.`,
  ];
  steps.push(
    openPullRequests
      ? `Then push the branch with \`git push -u origin ${worktree.branch}\` and open a pull request against ${worktree.base} with \`gh pr create\`: the commit's title as its title, and a body saying what changed, how you verified it, and \`Refs ${id}\`. Put the pull request URL in your Linear comment and your final report.`
      : "Do not push the branch or open a pull request; the user reviews the branch locally.",
  );
  return steps;
}

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
  opts: {
    openPullRequests?: boolean;
    decision?: DispatchDecision | null;
    handoff?: Handoff | null;
  } = {},
): string {
  const handoff = opts.handoff;
  const lines = [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
  ];
  // HOY-353: the Dispatcher's Auto verdict, so the run knows why it was chosen.
  if (opts.decision) {
    lines.push(
      `Auto-assigned by the Dispatcher: ${opts.decision.reason} (confidence ${opts.decision.confidence.toFixed(2)}).`,
    );
  }
  if (handoff) lines.push(`Handed to you from ${handoff.fromAgent}: ${handoff.reason}`);
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.description) lines.push("", issue.description);
  lines.push(
    "",
    (handoff && handoffAsk(agent, handoff, worktree?.branch)) ??
      (agent && ISSUE_ASK[agent]) ??
      "Work on this issue.",
    ...(handoff?.report
      ? ["", `<previous_report agent="${handoff.fromAgent}">`, handoff.report, "</previous_report>"]
      : []),
    ...(worktree
      ? [
          "",
          `You are working in a dedicated git worktree at ${worktree.path}, on branch ${worktree.branch} created from ${worktree.base}. Other agents work in their own worktrees, so keep every change here. Dependencies may not be installed in this worktree; install them with the project's package manager if its checks need them.`,
        ]
      : []),
    "",
    ...(worktree ? ["", ...finishSteps(issue.identifier, worktree, !!opts.openPullRequests)] : []),
    "",
    agent && KEEPS_STATE.has(agent)
      ? `When you are done, post your report on ${issue.identifier} with linear_comment. Leave the issue's state as it is; the Fleet routes it to the next step.`
      : worktree
      ? `Then post your report on ${issue.identifier} with linear_comment and move it with linear_set_state: to a review state (In Review) if you committed changes, or Done if the task needed none. File anything out of scope as a follow-up with linear_create_issue.`
      : `When you are done, post your report on ${issue.identifier} with linear_comment, then move it with linear_set_state. File anything out of scope as a follow-up with linear_create_issue.`,
  );
  return lines.join("\n").replaceAll("\u0000", "");
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// HOY-359: the last GitHub pull request URL a run mentioned, in its replies or
// in tool output such as `gh pr create`.
export function findPullRequestUrl(turns: Turn[]): string | null {
  let found: string | null = null;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      const text = block.kind === "text" ? block.content : (block.tool.output ?? "");
      for (const m of text.match(PR_URL) ?? []) found = m;
    }
  }
  return found;
}
