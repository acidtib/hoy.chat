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
  // HOY-298 (Goal Mode v2): optional deterministic verify gate. When set, the
  // loop runs `verifyCommand` (in `verifyCwd`, default the project cwd) and
  // requires exit 0 before declaring the goal met. Persisted on the goal so the
  // gate survives restart. Task A plumbs these through; Task B wires the gate.
  verifyCommand?: string;
  verifyCwd?: string;
}

export const GOAL_DEFAULT_CAP_TURNS = 25;

const GOAL_CONDITION_MAX_LENGTH = 4000;

export type GoalCommand =
  | { kind: "set"; condition: string; verifyCommand?: string }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

// HOY-298: a trailing `--verify "<cmd>"` on a set command pins a deterministic
// verify gate. Double-quoted and anchored to the end so a condition may freely
// contain the word "verify" without triggering it; only the exact flag form is
// stripped. An empty quoted value ("") is treated as "no verify" (the flag is
// still stripped from the condition). A bare `--verify` with no quoted value
// does not match, so it stays part of the condition rather than erroring.
const VERIFY_FLAG_RE = /\s*--verify\s+"([^"]*)"\s*$/;

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

  // Peel a trailing --verify "<cmd>" off before validating the condition, so the
  // length cap applies to the condition alone. An empty quoted value yields no
  // verify command; a non-empty one is trimmed.
  let condition = arg;
  let verifyCommand: string | undefined;
  const verifyMatch = arg.match(VERIFY_FLAG_RE);
  if (verifyMatch) {
    condition = arg.slice(0, verifyMatch.index).trim();
    const value = verifyMatch[1].trim();
    if (value) verifyCommand = value;
  }

  // A --verify with no remaining condition is not a usable goal.
  if (condition.length === 0) return null;
  if (condition.length > GOAL_CONDITION_MAX_LENGTH) return null;
  return verifyCommand
    ? { kind: "set", condition, verifyCommand }
    : { kind: "set", condition };
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
