// HOY-263: pure goal-mode domain model, command parser, and loop reducer. No
// Tauri or Zustand imports here (import type only) so bun test can load this
// module standalone. The side-effectful wiring lives in store.ts.
import type { ModelRef } from "../lib/types";

export type GoalStatus = "active" | "paused" | "met" | "capped" | "cleared";

export interface ThreadGoal {
  condition: string;
  status: GoalStatus;
  turns: number;
  tokensBaseline: number;
  tokensUsed: number;
  startedAt: number;
  capTurns: number;
  evaluatorModel?: ModelRef;
  lastReason?: string;
}

export const GOAL_DEFAULT_CAP_TURNS = 25;

const GOAL_CONDITION_MAX_LENGTH = 4000;

export type GoalCommand =
  | { kind: "set"; condition: string }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

// Maps composer input to a goal subcommand. Returns null when the input is not
// a /goal command at all, so callers can fall through to normal message
// handling without a separate "is this a goal command" check.
export function parseGoalCommand(raw: string): GoalCommand | null {
  if (!raw.startsWith("/goal")) return null;
  const rest = raw.slice("/goal".length);
  // Reject "/goalish ..." etc: after the literal "/goal" the next char must be
  // whitespace or end of string.
  if (rest.length > 0 && !/^\s/.test(rest)) return null;

  const arg = rest.trim();
  if (arg.length === 0) return { kind: "status" };

  const lower = arg.toLowerCase();
  if (lower === "pause") return { kind: "pause" };
  if (lower === "resume") return { kind: "resume" };
  if (CLEAR_ALIASES.has(lower)) return { kind: "clear" };

  if (arg.length > GOAL_CONDITION_MAX_LENGTH) return null;
  return { kind: "set", condition: arg };
}

export interface TurnOutcome {
  aborted: boolean;
  errored: boolean;
  hasPendingUserPrompt: boolean;
  tokensNow: number;
}

export type GoalAction =
  | { type: "none" }
  | { type: "pause" }
  | { type: "cap"; turns: number }
  | { type: "yield" }
  | { type: "evaluate"; turns: number; tokensUsed: number };

// Decides what happens after a turn ends while a goal may be in effect.
// Pure: takes the current goal and turn outcome, returns the next action
// without mutating anything or performing any evaluator call itself.
export function nextGoalAction(
  goal: ThreadGoal | undefined,
  outcome: TurnOutcome,
): GoalAction {
  if (!goal || goal.status !== "active") return { type: "none" };
  if (outcome.aborted || outcome.errored) return { type: "pause" };

  const turns = goal.turns + 1;
  if (turns >= goal.capTurns) return { type: "cap", turns };
  if (outcome.hasPendingUserPrompt) return { type: "yield" };

  return {
    type: "evaluate",
    turns,
    tokensUsed: outcome.tokensNow - goal.tokensBaseline,
  };
}

export interface EvaluationResult {
  met: boolean;
  reason: string;
}

export type EvaluationOutcome =
  | { type: "met"; reason: string }
  | { type: "continue"; reason: string };

// Maps the cheap evaluator's verdict to the next goal-loop outcome. Kept
// separate from nextGoalAction because the evaluator call itself is
// asynchronous and effectful; this half stays pure.
export function applyEvaluation(
  _goal: ThreadGoal,
  evaluation: EvaluationResult,
): EvaluationOutcome {
  return evaluation.met
    ? { type: "met", reason: evaluation.reason }
    : { type: "continue", reason: evaluation.reason };
}
