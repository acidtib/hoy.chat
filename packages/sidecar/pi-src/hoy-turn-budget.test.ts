import { test, expect } from "bun:test";
import { createHoyTurnBudget } from "./hoy-turn-budget";

// Drive the extension's turn_end handler directly with a fake pi + ctx so we can
// assert exactly when it aborts, without a live agent.
function harness(maxTurns: number) {
  let handler: ((event: unknown, ctx: unknown) => void) | undefined;
  const pi = {
    on: (evt: string, h: (event: unknown, ctx: unknown) => void) => {
      if (evt === "turn_end") handler = h;
    },
  };
  createHoyTurnBudget(maxTurns)(pi as never);
  let aborted = 0;
  const ctx = { abort: () => (aborted += 1) };
  return {
    turnEnd: (turnIndex: number) =>
      handler?.({ type: "turn_end", turnIndex, message: {}, toolResults: [] }, ctx),
    aborted: () => aborted,
  };
}

test("aborts once the turn budget is spent (HOY-244)", () => {
  const h = harness(3);
  h.turnEnd(0);
  expect(h.aborted()).toBe(0);
  h.turnEnd(1);
  expect(h.aborted()).toBe(0);
  // The 3rd turn (index 2) reaches the budget of 3, so the run is aborted.
  h.turnEnd(2);
  expect(h.aborted()).toBe(1);
});

test("does not abort before the budget is reached (HOY-244)", () => {
  const h = harness(10);
  for (let i = 0; i < 9; i++) h.turnEnd(i);
  expect(h.aborted()).toBe(0);
});
