import { describe, expect, test } from "bun:test";
import { extractProposedPlan, planKickoffPrompt } from "@/lib/plan";

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
