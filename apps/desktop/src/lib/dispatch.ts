// Pure helpers for Fleet Auto mode (HOY-353).

import type {
  CachedDecision,
  DispatchDecision,
  LinearIssue,
  SubagentDef,
  Thread,
} from "./types";

// Ready issues route to the named agent only at or above this confidence.
export const DISPATCH_CONFIDENCE_THRESHOLD = 0.7;

// Match the sidecar caps.
export const DISPATCH_HISTORY_MAX = 20;
// The input rides one env var, which Linux caps at 128 KiB.
export const DISPATCH_DESCRIPTION_MAX = 4000;

// The `agent:<Name>` label override: skips the model call entirely.
export function agentLabel(labels: string[]): string | null {
  const label = labels.find((l) => l.toLowerCase().startsWith("agent:"));
  const name = label?.slice("agent:".length).trim();
  return name || null;
}

export function needsDecision(
  issue: LinearIssue,
  decisions: Record<string, CachedDecision> | undefined,
): boolean {
  return decisions?.[issue.id]?.at !== (issue.updatedAt ?? null);
}

export interface DispatchInput {
  issue: {
    identifier: string;
    title: string;
    description?: string | null;
    labels?: string[];
    priorityLabel?: string;
    estimate?: number | null;
  };
  agents: Array<{ name: string; description?: string | null }>;
  history?: Array<{ identifier: string; title: string; agent: string }>;
}

export function dispatchInput(
  issue: LinearIssue,
  agents: SubagentDef[],
  threads: Thread[],
): DispatchInput {
  const history = threads
    .filter((t) => t.linearIssue && t.fleetRun && t.agent)
    .map((t) => ({
      identifier: t.linearIssue!.identifier,
      title: t.linearIssue!.title,
      agent: t.agent!,
    }))
    .slice(0, DISPATCH_HISTORY_MAX);
  return {
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description?.slice(0, DISPATCH_DESCRIPTION_MAX) ?? null,
      labels: issue.labels,
      priorityLabel: issue.priorityLabel,
      estimate: issue.estimate,
    },
    agents: agents.map((a) => ({
      name: a.name,
      description: a.description ?? null,
    })),
    history,
  };
}

export type DispatchAction =
  | { kind: "queue"; agent: string }
  | { kind: "comment" }
  | { kind: "hold" };

// A dispatcher error holds rather than comments: the author has nothing to add.
export function applyDecision(
  decision: DispatchDecision,
  agents: SubagentDef[],
): DispatchAction {
  if (decision.ready && decision.agent) {
    const known = agents.find((a) => a.name === decision.agent);
    if (known && decision.confidence >= DISPATCH_CONFIDENCE_THRESHOLD) {
      return { kind: "queue", agent: known.name };
    }
  }
  if (!decision.ready && !decision.reason.startsWith("dispatcher error")) {
    return { kind: "comment" };
  }
  return { kind: "hold" };
}

export function nagComment(issue: LinearIssue, decision: DispatchDecision): string {
  const missing = decision.missing?.trim() || decision.reason;
  return `${missing}\n\n_Posted by Hoy's Auto mode: ${issue.identifier} was left unassigned because it is not ready for an agent yet._`;
}

export function decisionCosts(
  decisions: Record<string, CachedDecision> | undefined,
): number {
  return Object.values(decisions ?? {}).reduce(
    (sum, d) => sum + (d.decision.cost ?? 0),
    0,
  );
}
