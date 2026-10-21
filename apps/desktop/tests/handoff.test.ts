import { expect, test } from "bun:test";
import { MAX_FIX_ROUNDS, nextStep, runSignals, type RunSignals } from "@/lib/handoff";
import type { Turn } from "@/lib/types";

const text = (content: string) => ({ kind: "text" as const, content });
const tool = (name: string, output: string, isError = false) => ({
  kind: "tool" as const,
  tool: { id: name, name, title: name, output, isError, running: false },
});
const run = (...blocks: ReturnType<typeof text | typeof tool>[]): Turn[] => [
  { role: "user", text: "brief" },
  { role: "assistant", blocks } as Turn,
];

const enabled = ["Architect", "Coder", "Reviewer", "Researcher"];
const done = (s: Partial<RunSignals>) => ({ report: "", ...s });

test("reads the last state, the agent's own handoff, and the review verdict", () => {
  const s = runSignals(
    run(
      tool("linear_set_state", '{"state": "In Progress"}'),
      tool("linear_set_state", '{\n  "identifier": "HOY-1",\n  "state": "In Review",\n  "from": "In Progress"\n}'),
      tool("linear_set_state", "Linear error", true),
      text("**Verdict:** Fix first\n\n1. high, a.ts:3"),
    ),
  );
  expect(s.state).toBe("review");
  expect(s.verdict).toBe("fix");
  expect(s.report).toStartWith("**Verdict:** Fix first");

  const h = runSignals(run(tool("fleet_handoff", '{"handoff":{"agent":"Researcher","reason":"Only a question."}}\nHanded off.')));
  expect(h.handoff).toEqual({ agent: "Researcher", reason: "Only a question." });
});

test("a run that did not finish cleanly never hands off", () => {
  for (const outcome of ["stopped", "error", "interrupted", null] as const) {
    expect(nextStep("Coder", outcome, done({ state: "review" }), 0, enabled)).toBeNull();
  }
});

test("the agent's own handoff wins, and without a name goes to the Dispatcher", () => {
  const h = { agent: "Researcher", reason: "Only a question." };
  expect(nextStep("Coder", "done", done({ handoff: h, state: "review" }), 0, enabled)).toMatchObject({
    kind: "agent",
    agent: "Researcher",
    by: "agent",
  });
  expect(nextStep("Coder", "done", done({ handoff: { agent: null, reason: "x" } }), 0, enabled)).toMatchObject({
    kind: "dispatch",
    by: "agent",
  });
});

test("Architect to Coder, review state to Reviewer, done stops", () => {
  expect(nextStep("Architect", "done", done({}), 0, enabled)).toMatchObject({ kind: "agent", agent: "Coder" });
  expect(nextStep("Coder", "done", done({ state: "review" }), 0, enabled)).toMatchObject({
    kind: "agent",
    agent: "Reviewer",
  });
  expect(nextStep("Coder", "done", done({ state: "done" }), 0, enabled)).toMatchObject({
    kind: "stop",
    needsUser: false,
  });
  expect(nextStep("Researcher", "done", done({}), 0, enabled)).toMatchObject({ kind: "dispatch", by: "rule" });
});

test("Reviewer: Fix first goes back to Coder until the round cap, Ship stops", () => {
  expect(nextStep("Reviewer", "done", done({ verdict: "fix" }), 0, enabled)).toMatchObject({
    kind: "agent",
    agent: "Coder",
    round: 1,
  });
  expect(nextStep("Reviewer", "done", done({ verdict: "fix" }), MAX_FIX_ROUNDS, enabled)).toMatchObject({
    kind: "stop",
    needsUser: true,
  });
  expect(nextStep("Reviewer", "done", done({ verdict: "ship" }), 1, enabled)).toMatchObject({
    kind: "stop",
    needsUser: false,
  });
  expect(nextStep("Reviewer", "done", done({ verdict: "discuss" }), 0, enabled)).toMatchObject({ needsUser: true });
  expect(nextStep("Reviewer", "done", done({}), 0, enabled)).toMatchObject({ needsUser: true });
});

test("a disabled next agent stops the chain for the user", () => {
  expect(nextStep("Coder", "done", done({ state: "review" }), 0, ["Coder"])).toMatchObject({
    kind: "stop",
    needsUser: true,
  });
});
