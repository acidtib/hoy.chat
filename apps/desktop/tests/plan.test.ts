import { describe, expect, test } from "bun:test";
import {
  detectPlanIntent,
  extractProposedPlan,
  planKickoffPrompt,
  planSubagentKickoffPrompt,
  splitPlanSegments,
} from "@/lib/plan";

describe("extractProposedPlan", () => {
  test("pulls the plan out of a proposed_plan block", () => {
    const text = "Here is my plan.\n\n<proposed_plan>\n# Title\n\n## Summary\nDo the thing.\n</proposed_plan>";
    expect(extractProposedPlan(text)).toBe("# Title\n\n## Summary\nDo the thing.");
  });

  test("is case-insensitive on the tag", () => {
    expect(extractProposedPlan("<PROPOSED_PLAN>x</PROPOSED_PLAN>")).toBe("x");
  });

  test("returns null when there is no block", () => {
    expect(extractProposedPlan("just some prose with no plan")).toBeNull();
  });

  test("returns null for an empty block", () => {
    expect(extractProposedPlan("<proposed_plan>   </proposed_plan>")).toBeNull();
  });

  test("takes only the block content, not surrounding text", () => {
    const text = "intro <proposed_plan>the plan</proposed_plan> outro";
    expect(extractProposedPlan(text)).toBe("the plan");
  });
});

describe("planKickoffPrompt", () => {
  test("embeds the plan when present", () => {
    const p = planKickoffPrompt("# Do X");
    expect(p).toContain("Implement this approved plan now");
    expect(p).toContain("# Do X");
  });

  test("still returns an instruction when the plan is missing", () => {
    const p = planKickoffPrompt(undefined);
    expect(p).toContain("Implement this approved plan now");
  });
});

describe("planSubagentKickoffPrompt (HOY-295)", () => {
  test("embeds the plan and instructs task-by-task subagent orchestration", () => {
    const p = planSubagentKickoffPrompt("# Do X");
    expect(p).toContain("task-by-task using subagents");
    expect(p).toContain("# Do X");
    // One subagent at a time, ending the turn so the delivered result auto-wakes
    // the parent for the next step (rides HOY-231/233).
    expect(p).toContain("one subagent at a time");
    expect(p).toContain("review it");
  });

  test("still returns an instruction when the plan is missing", () => {
    expect(planSubagentKickoffPrompt(undefined)).toContain(
      "task-by-task using subagents",
    );
  });

  test("does not fire the plan-intent auto-switch", () => {
    // Like the inline kickoff, executing an approved plan must not bounce the
    // thread back into plan mode.
    expect(detectPlanIntent(planSubagentKickoffPrompt("# Step 1\nDo it."))).toBe(
      false,
    );
  });
});

describe("splitPlanSegments", () => {
  test("plain prose is a single markdown segment", () => {
    expect(splitPlanSegments("just some text")).toEqual([
      { kind: "markdown", text: "just some text" },
    ]);
  });

  test("empty input yields no segments", () => {
    expect(splitPlanSegments("")).toEqual([]);
  });

  test("splits prose, plan, and trailing prose around a closed block", () => {
    expect(
      splitPlanSegments("Intro\n<proposed_plan>\n# Step 1\n</proposed_plan>\ntrailing"),
    ).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "plan", text: "\n# Step 1\n", streaming: false },
      { kind: "markdown", text: "\ntrailing" },
    ]);
  });

  test("a lone closed block yields just the plan segment", () => {
    expect(splitPlanSegments("<proposed_plan>\nall plan\n</proposed_plan>")).toEqual([
      { kind: "plan", text: "\nall plan\n", streaming: false },
    ]);
  });

  test("tag matching is case-insensitive", () => {
    expect(splitPlanSegments("<Proposed_Plan>X</Proposed_Plan>")).toEqual([
      { kind: "plan", text: "X", streaming: false },
    ]);
  });

  test("an open block with no close streams into the plan segment", () => {
    expect(splitPlanSegments("Here:\n<proposed_plan>\n1. first step")).toEqual([
      { kind: "markdown", text: "Here:\n" },
      { kind: "plan", text: "\n1. first step", streaming: true },
    ]);
  });

  test("withholds a partial opening tag arriving at the tail", () => {
    // The dangling "<propo" must not flash as raw markdown before it completes.
    expect(splitPlanSegments("Here is my plan:\n<propo")).toEqual([
      { kind: "markdown", text: "Here is my plan:\n" },
    ]);
  });

  test("withholds a partial closing tag while the body still streams", () => {
    expect(
      splitPlanSegments("Here:\n<proposed_plan>\n1. first\n</proposed_pl"),
    ).toEqual([
      { kind: "markdown", text: "Here:\n" },
      { kind: "plan", text: "\n1. first\n", streaming: true },
    ]);
  });
});

describe("detectPlanIntent", () => {
  test.each([
    "make a plan",
    "Make a plan for the auth refactor",
    "can you make a plan for this?",
    "come up with a plan to migrate the store",
    "put together a plan first",
    "write a plan for the new sidebar",
    "draft a plan",
    "give me a plan before you touch anything",
    "outline a plan for the rewrite",
    "propose a plan for handling errors",
    "I need a plan for the migration",
    "I want a plan here",
    "let's plan this out",
    "let's first make a plan",
    "plan out the refactor",
    "plan how to split the module",
    "plan the migration",
    "plan this out before coding",
    "switch to plan mode",
    "Plan the auth system end to end",
    // "directly"/"direction" must not be swallowed by the plan-dir(ectory) guard.
    "make a plan for the refactor and give the plan directly",
    "plan the migration directly",
  ])("fires on plan request: %j", (msg) => {
    expect(detectPlanIntent(msg)).toBe(true);
  });

  test.each([
    "",
    "fix the failing test",
    "implement the plan",
    "the plan looks good, let's implement it",
    "follow the plan we agreed on",
    "execute the plan",
    "stick to the plan",
    "ship the plan",
    "open the plan file",
    "read the plans directory",
    "update the pricing plan copy",
    "the subscription plan page is broken",
    "add a data plan selector",
    "what's the plan?",
    "everything went as planned",
    "explain the plan to me",
    "review the plan and comment",
  ])("does not fire on: %j", (msg) => {
    expect(detectPlanIntent(msg)).toBe(false);
  });

  test("does not fire on the plan-kickoff prompt", () => {
    expect(detectPlanIntent(planKickoffPrompt("# Step 1\nDo the thing."))).toBe(false);
  });
});
