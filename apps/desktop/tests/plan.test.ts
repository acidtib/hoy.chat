import { describe, expect, test } from "bun:test";
import { extractProposedPlan, planKickoffPrompt, splitPlanSegments } from "@/lib/plan";

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
