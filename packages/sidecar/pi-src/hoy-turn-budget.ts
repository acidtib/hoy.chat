import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// HOY-244: enforce a per-subagent-type turn budget. Pi exposes no native turn
// cap, so we watch turn completions and abort the run once the budget is spent.
// The child still delivers whatever it produced up to that point (a partial
// result is the intended outcome of a runaway guard). abort() is the same clean
// stop as a user cancel, so the turn ends and delivery proceeds normally.
//
// Installed only for subagent types whose .md sets `max_turns: N` (see the
// factory in hoy-sidecar.ts); root/user threads are never budgeted.
export function createHoyTurnBudget(maxTurns: number) {
  return function hoyTurnBudget(pi: ExtensionAPI) {
    pi.on("turn_end", (event, ctx) => {
      // turnIndex is 0-based within the run, so the Nth turn is index N-1. Abort
      // once that turn completes, before an (N+1)th can start.
      if (event.turnIndex + 1 >= maxTurns) {
        ctx.abort();
      }
    });
  };
}
