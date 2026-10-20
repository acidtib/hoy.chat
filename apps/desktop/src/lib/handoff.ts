// Pure rules for Fleet handoffs (HOY-379): what a finished run signalled, and
// which agent, if any, takes the issue next.

import type { FleetOutcome, HandoffBy, Turn } from "./types";

// Fix first rounds before the chain stops for the user.
export const MAX_FIX_ROUNDS = 2;
// Handoffs on one issue before the chain stops for the user, so two agents
// routed by the Dispatcher cannot pass it back and forth forever.
export const MAX_HOPS = 6;
// The prior report carried into the next brief keeps its end, where the verdict is.
export const MAX_REPORT_CHARS = 8000;

export type Verdict = "ship" | "fix" | "discuss";

export interface RunSignals {
  // The run's own fleet_handoff call.
  handoff?: { agent: string | null; reason: string };
  verdict?: Verdict;
  // The last state the run moved the issue to with linear_set_state.
  state?: "review" | "done" | "other";
  report: string;
}

const VERDICT = /verdict[\s*_:-]*(ship|fix first|needs discussion)/gi;

function classifyState(name: string): RunSignals["state"] {
  if (/review/i.test(name)) return "review";
  if (/done|complete|closed|cancel|duplicate/i.test(name)) return "done";
  return "other";
}

export function runSignals(turns: Turn[]): RunSignals {
  const signals: RunSignals = { report: "" };
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.kind === "text") {
        if (block.content.trim()) signals.report = block.content.trim();
        continue;
      }
      const tool = block.tool;
      if (tool.isError || tool.running) continue;
      try {
        if (tool.name === "fleet_handoff") {
          signals.handoff = JSON.parse(tool.output.split("\n")[0]).handoff;
        } else if (tool.name === "linear_set_state") {
          const state = JSON.parse(tool.output).state;
          if (typeof state === "string") signals.state = classifyState(state);
        }
      } catch {
        // Not the shape this tool prints; ignore it.
      }
    }
  }
  const verdicts = [...signals.report.matchAll(VERDICT)];
  const last = verdicts.at(-1)?.[1].toLowerCase();
  if (last) signals.verdict = last === "ship" ? "ship" : last === "fix first" ? "fix" : "discuss";
  signals.report = signals.report.slice(-MAX_REPORT_CHARS);
  return signals;
}

export type NextStep =
  | { kind: "agent"; agent: string; reason: string; by: HandoffBy; round: number }
  | { kind: "dispatch"; reason: string; by: HandoffBy }
  | { kind: "stop"; reason: string; needsUser: boolean };

// Null when the run did not finish cleanly: a stopped or failed run ends the
// chain, and its agent's queue halts as before.
export function nextStep(
  agent: string,
  outcome: FleetOutcome | null | undefined,
  signals: RunSignals,
  round: number,
  enabled: string[],
): NextStep | null {
  if (outcome !== "done") return null;
  const to = (name: string, reason: string, by: HandoffBy, nextRound = round): NextStep =>
    enabled.includes(name)
      ? { kind: "agent", agent: name, reason, by, round: nextRound }
      : { kind: "stop", reason: `${reason} ${name} is not enabled, so it waits for you.`, needsUser: true };

  if (signals.handoff) {
    const { agent: named, reason } = signals.handoff;
    return named ? to(named, reason, "agent") : { kind: "dispatch", reason, by: "agent" };
  }
  if (agent === "Reviewer") {
    if (signals.verdict === "fix") {
      if (round >= MAX_FIX_ROUNDS) {
        return {
          kind: "stop",
          reason: `Still Fix first after ${MAX_FIX_ROUNDS} review rounds.`,
          needsUser: true,
        };
      }
      return to("Coder", "Review asked for fixes.", "rule", round + 1);
    }
    if (signals.verdict === "ship") return { kind: "stop", reason: "Review says ship.", needsUser: false };
    if (signals.verdict === "discuss") {
      return { kind: "stop", reason: "Review needs a discussion.", needsUser: true };
    }
    return { kind: "stop", reason: "The review gave no verdict.", needsUser: true };
  }
  if (agent === "Architect") return to("Coder", "The plan is ready to implement.", "rule");
  if (signals.state === "review") return to("Reviewer", `${agent} moved it to review.`, "rule");
  if (signals.state === "done") return { kind: "stop", reason: `${agent} finished it.`, needsUser: false };
  return { kind: "dispatch", reason: `${agent} finished without a next step.`, by: "rule" };
}

// The Linear note for one step of the chain.
export function chainComment(from: string, step: NextStep): string {
  const body =
    step.kind === "agent"
      ? `Handed from ${from} to ${step.agent}: ${step.reason}`
      : step.kind === "stop"
        ? `${step.needsUser ? "Waiting for you" : "Stopped"} after ${from}: ${step.reason}`
        : `${from} finished; asking the Dispatcher for the next step.`;
  return `${body}\n\n_Hoy Fleet handoff_`;
}
