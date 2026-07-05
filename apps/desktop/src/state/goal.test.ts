import { test, expect, describe } from "bun:test";
import {
  GOAL_DEFAULT_CAP_TURNS,
  parseGoalCommand,
  nextGoalAction,
  applyEvaluation,
  type ThreadGoal,
} from "./goal";

const baseGoal = (over: Partial<ThreadGoal> = {}): ThreadGoal => ({
  condition: "ship the feature",
  status: "active",
  turns: 0,
  tokensBaseline: 0,
  tokensUsed: 0,
  startedAt: 0,
  capTurns: GOAL_DEFAULT_CAP_TURNS,
  ...over,
});

describe("parseGoalCommand", () => {
  test("bare /goal is a status query", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
  });

  test("bare /goal with trailing whitespace is still a status query", () => {
    expect(parseGoalCommand("/goal   ")).toEqual({ kind: "status" });
  });

  test("/goal <text> sets the condition, trimmed", () => {
    expect(parseGoalCommand("/goal   fix all failing tests  ")).toEqual({
      kind: "set",
      condition: "fix all failing tests",
    });
  });

  test("/goal <text> over 4000 chars is rejected", () => {
    const long = "a".repeat(4001);
    expect(parseGoalCommand(`/goal ${long}`)).toBeNull();
  });

  test("/goal <text> at exactly 4000 chars is accepted", () => {
    const exact = "a".repeat(4000);
    expect(parseGoalCommand(`/goal ${exact}`)).toEqual({
      kind: "set",
      condition: exact,
    });
  });

  test("/goal pause", () => {
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
  });

  test("/goal resume", () => {
    expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
  });

  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
    test(`/goal ${alias} clears the goal`, () => {
      expect(parseGoalCommand(`/goal ${alias}`)).toEqual({ kind: "clear" });
    });
  }

  test("clear aliases are case-insensitive", () => {
    expect(parseGoalCommand("/goal STOP")).toEqual({ kind: "clear" });
  });

  test("pause/resume are case-insensitive", () => {
    expect(parseGoalCommand("/goal PAUSE")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal RESUME")).toEqual({ kind: "resume" });
  });

  test("non-/goal input returns null", () => {
    expect(parseGoalCommand("/help")).toBeNull();
    expect(parseGoalCommand("hello there")).toBeNull();
    expect(parseGoalCommand("")).toBeNull();
  });

  test("/goalish is not a /goal command", () => {
    expect(parseGoalCommand("/goalish thing")).toBeNull();
  });

  // HOY-298: optional trailing --verify "<cmd>" gate.
  test('/goal <text> --verify "<cmd>" captures the verify command', () => {
    expect(parseGoalCommand('/goal do X --verify "bun test"')).toEqual({
      kind: "set",
      condition: "do X",
      verifyCommand: "bun test",
    });
  });

  test("/goal <text> without --verify has no verifyCommand", () => {
    expect(parseGoalCommand("/goal do X")).toEqual({
      kind: "set",
      condition: "do X",
    });
  });

  test("a condition containing the word 'verify' but not the flag is unaffected", () => {
    expect(parseGoalCommand("/goal verify the deploy pipeline runs")).toEqual({
      kind: "set",
      condition: "verify the deploy pipeline runs",
    });
  });

  test("a bare --verify with no quoted value stays part of the condition", () => {
    expect(parseGoalCommand("/goal do X --verify bun test")).toEqual({
      kind: "set",
      condition: "do X --verify bun test",
    });
  });

  test('an empty --verify "" is treated as no verify command', () => {
    expect(parseGoalCommand('/goal do X --verify ""')).toEqual({
      kind: "set",
      condition: "do X",
    });
  });

  test("--verify with only whitespace inside quotes yields no verify command", () => {
    expect(parseGoalCommand('/goal do X --verify "   "')).toEqual({
      kind: "set",
      condition: "do X",
    });
  });

  test("--verify with no remaining condition is rejected", () => {
    expect(parseGoalCommand('/goal --verify "bun test"')).toBeNull();
  });

  test("the condition length cap applies after the --verify flag is stripped", () => {
    const exact = "a".repeat(4000);
    expect(parseGoalCommand(`/goal ${exact} --verify "bun test"`)).toEqual({
      kind: "set",
      condition: exact,
      verifyCommand: "bun test",
    });
    const tooLong = "a".repeat(4001);
    expect(parseGoalCommand(`/goal ${tooLong} --verify "bun test"`)).toBeNull();
  });
});

describe("nextGoalAction", () => {
  const outcome = (over: Partial<Parameters<typeof nextGoalAction>[1]> = {}) => ({
    aborted: false,
    errored: false,
    hasPendingUserPrompt: false,
    tokensNow: 0,
    ...over,
  });

  test("a missing goal takes no action", () => {
    expect(nextGoalAction(undefined, outcome())).toEqual({ type: "none" });
  });

  test("a paused goal takes no action", () => {
    expect(nextGoalAction(baseGoal({ status: "paused" }), outcome())).toEqual({
      type: "none",
    });
  });

  test("a met goal takes no action", () => {
    expect(nextGoalAction(baseGoal({ status: "met" }), outcome())).toEqual({
      type: "none",
    });
  });

  test("an aborted turn pauses the goal", () => {
    expect(
      nextGoalAction(baseGoal(), outcome({ aborted: true })),
    ).toEqual({ type: "pause" });
  });

  test("an errored turn pauses the goal", () => {
    expect(
      nextGoalAction(baseGoal(), outcome({ errored: true })),
    ).toEqual({ type: "pause" });
  });

  test("aborted takes priority over errored, both just pause", () => {
    expect(
      nextGoalAction(baseGoal(), outcome({ aborted: true, errored: true })),
    ).toEqual({ type: "pause" });
  });

  test("hitting the cap boundary exactly caps the goal", () => {
    const goal = baseGoal({ turns: GOAL_DEFAULT_CAP_TURNS - 1, capTurns: GOAL_DEFAULT_CAP_TURNS });
    expect(nextGoalAction(goal, outcome())).toEqual({
      type: "cap",
      turns: GOAL_DEFAULT_CAP_TURNS,
    });
  });

  test("one turn below the cap boundary does not cap", () => {
    const goal = baseGoal({ turns: GOAL_DEFAULT_CAP_TURNS - 2, capTurns: GOAL_DEFAULT_CAP_TURNS });
    const result = nextGoalAction(goal, outcome({ tokensNow: 10 }));
    expect(result.type).toBe("evaluate");
  });

  test("a pending user prompt yields instead of evaluating", () => {
    const goal = baseGoal({ turns: 2 });
    expect(
      nextGoalAction(goal, outcome({ hasPendingUserPrompt: true })),
    ).toEqual({ type: "yield" });
  });

  test("cap check takes priority over pending-user-prompt", () => {
    const goal = baseGoal({ turns: GOAL_DEFAULT_CAP_TURNS - 1, capTurns: GOAL_DEFAULT_CAP_TURNS });
    expect(
      nextGoalAction(goal, outcome({ hasPendingUserPrompt: true })),
    ).toEqual({ type: "cap", turns: GOAL_DEFAULT_CAP_TURNS });
  });

  test("the normal path evaluates with incremented turns and computed tokensUsed", () => {
    const goal = baseGoal({ turns: 3, tokensBaseline: 100 });
    expect(nextGoalAction(goal, outcome({ tokensNow: 350 }))).toEqual({
      type: "evaluate",
      turns: 4,
      tokensUsed: 250,
    });
  });
});

describe("applyEvaluation", () => {
  test("met evaluation reports met with the reason", () => {
    expect(applyEvaluation(baseGoal(), { met: true, reason: "done" })).toEqual({
      type: "met",
      reason: "done",
    });
  });

  test("unmet evaluation reports continue with the reason", () => {
    expect(
      applyEvaluation(baseGoal(), { met: false, reason: "not yet" }),
    ).toEqual({ type: "continue", reason: "not yet" });
  });
});
