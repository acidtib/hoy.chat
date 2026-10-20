import { expect, test } from "bun:test";
import {
  DISPATCH_CONFIDENCE_THRESHOLD,
  agentLabel,
  applyDecision,
  decisionCosts,
  dispatchInput,
  nagComment,
  needsDecision,
} from "@/lib/dispatch";
import type { CachedDecision, DispatchDecision, LinearIssue, SubagentDef, Thread } from "@/lib/types";

function issue(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "i1",
    identifier: "HOY-1",
    title: "Add a dark mode toggle",
    description: "In Settings.",
    url: "",
    priority: 3,
    priorityLabel: "Medium",
    estimate: 2,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...over,
  };
}

const coder = { name: "Coder", description: "Implements changes." } as SubagentDef;
const reviewer = { name: "Reviewer" } as SubagentDef;

test("agentLabel reads the agent: override and ignores other labels", () => {
  expect(agentLabel(["UI", "agent:Coder", "bug"])).toBe("Coder");
  expect(agentLabel(["agent: Security Reviewer"])).toBe("Security Reviewer");
  expect(agentLabel(["agent:", "UI"])).toBeNull();
  expect(agentLabel(["UI"])).toBeNull();
});

test("needsDecision keys the cache to the issue revision", () => {
  const at = (d: CachedDecision) => d;
  const i = issue();
  const fresh = at({ at: i.updatedAt ?? null, decision: { ready: true, agent: null, confidence: 1, reason: "x" } });
  expect(needsDecision(i, { i1: fresh })).toBe(false);
  expect(needsDecision(i, { i1: { ...fresh, at: "older" } })).toBe(true);
  expect(needsDecision(i, {})).toBe(true);
  expect(needsDecision(issue({ updatedAt: null }), { i1: { ...fresh, at: null } })).toBe(false);
});

test("dispatchInput sends the issue, the available agents and recent history", () => {
  const threads = [
    { linearIssue: { identifier: "HOY-0", title: "Old task" }, fleetRun: {}, agent: "Coder" },
    { linearIssue: { identifier: "HOY-2", title: "Later" }, fleetRun: {}, agent: "Reviewer" },
  ] as unknown as Thread[];
  const input = dispatchInput(issue(), [coder, reviewer], threads);
  expect(input.issue.identifier).toBe("HOY-1");
  expect(input.issue.labels).toEqual([]);
  expect(input.agents).toEqual([
    { name: "Coder", description: "Implements changes." },
    { name: "Reviewer", description: null },
  ]);
  expect(input.history).toEqual([
    { identifier: "HOY-0", title: "Old task", agent: "Coder" },
    { identifier: "HOY-2", title: "Later", agent: "Reviewer" },
  ]);
});

test("applyDecision queues only a confident known agent", () => {
  const d = (over: Partial<DispatchDecision>): DispatchDecision => ({
    ready: true,
    agent: "Coder",
    confidence: 0.9,
    reason: "Implementation work.",
    ...over,
  });
  expect(applyDecision(d({}), [coder])).toEqual({ kind: "queue", agent: "Coder" });
  // Below the threshold: held for the user, the card shows the reason.
  expect(applyDecision(d({ confidence: DISPATCH_CONFIDENCE_THRESHOLD - 0.01 }), [coder])).toEqual({ kind: "hold" });
  // Unknown agent: never queued, held.
  expect(applyDecision(d({ agent: "Wizard" }), [coder])).toEqual({ kind: "hold" });
  // Not ready: the author gets a note.
  expect(applyDecision(d({ ready: false, missing: "Say which page." }), [coder])).toEqual({ kind: "comment" });
  // A dispatcher failure is a hold, not a nag on the issue.
  expect(
    applyDecision(d({ ready: false, agent: null, confidence: 0, reason: "dispatcher error: no model" }), [coder]),
  ).toEqual({ kind: "hold" });
});

test("nagComment is written to the author and names the sender", () => {
  const body = nagComment(issue(), {
    ready: false,
    agent: null,
    confidence: 0.4,
    reason: "Vague.",
    missing: "Say which page is slow.",
  });
  expect(body).toContain("Say which page is slow.");
  expect(body).toContain("HOY-1");
  expect(body).toContain("Auto mode");
});

test("decisionCosts sums every cached verdict", () => {
  const decisions: Record<string, CachedDecision> = {
    a: { at: null, decision: { ready: true, agent: null, confidence: 1, reason: "x", cost: 0.001 } },
    b: { at: null, decision: { ready: false, agent: null, confidence: 0, reason: "x", cost: 0.0005 } },
    c: { at: null, decision: { ready: true, agent: null, confidence: 1, reason: "x" } },
  };
  expect(decisionCosts(decisions)).toBeCloseTo(0.0015);
  expect(decisionCosts(undefined)).toBe(0);
});
