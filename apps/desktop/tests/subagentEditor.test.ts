import { describe, expect, test } from "bun:test";
import {
  emptyDraft,
  validateDraft,
  type SubagentDraft,
} from "@/components/settings/SubagentEditor";

// HOY-254: the authoring form's name/body/max-turns validation.
const base = (over: Partial<SubagentDraft> = {}): SubagentDraft => ({
  ...emptyDraft(),
  name: "code-reviewer",
  ...over,
});

function fields(d: SubagentDraft, taken: string[] = []) {
  return Object.keys(validateDraft(d, { takenNames: new Set(taken) }));
}

describe("validateDraft (HOY-254)", () => {
  test("a well-formed draft is saveable", () => {
    expect(fields(base())).toEqual([]);
  });

  test("empty name is rejected", () => {
    expect(fields(base({ name: "" }))).toContain("name");
  });

  test("non-slug names are rejected", () => {
    expect(fields(base({ name: "Code Reviewer" }))).toContain("name");
    expect(fields(base({ name: "-leading" }))).toContain("name");
    expect(fields(base({ name: "UPPER" }))).toContain("name");
  });

  test("built-in names are reserved (case-insensitive)", () => {
    for (const n of ["general-purpose", "Explore", "plan", "PLAN"]) {
      expect(fields(base({ name: n }))).toContain("name");
    }
  });

  test("a name already taken in the scope is rejected", () => {
    expect(fields(base({ name: "taken" }), ["taken"])).toContain("name");
    // A different lowercase slug in the same scope is fine.
    expect(fields(base({ name: "not-taken" }), ["taken"])).not.toContain("name");
  });

  test("an empty system prompt is rejected", () => {
    expect(fields(base({ body: "   " }))).toContain("body");
  });

  test("max turns must be a positive integer when set", () => {
    expect(fields(base({ maxTurns: "0" }))).toContain("maxTurns");
    expect(fields(base({ maxTurns: "-3" }))).toContain("maxTurns");
    expect(fields(base({ maxTurns: "2.5" }))).toContain("maxTurns");
    expect(fields(base({ maxTurns: "abc" }))).toContain("maxTurns");
    // Empty (unset) and a positive int are both fine.
    expect(fields(base({ maxTurns: "" }))).not.toContain("maxTurns");
    expect(fields(base({ maxTurns: "12" }))).not.toContain("maxTurns");
  });

  test("max turns above the u32 ceiling is rejected", () => {
    // The Rust field is Option<u32>; a larger value fails serde at the write.
    expect(fields(base({ maxTurns: "9999999999" }))).toContain("maxTurns");
    expect(fields(base({ maxTurns: "4294967295" }))).not.toContain("maxTurns");
  });

  test("edit mode skips the slug check on the locked name", () => {
    // A hand-authored non-slug file (my.agent.md) must be editable: the backend's
    // overwrite path accepts it, so the form must not block the save.
    expect(
      Object.keys(validateDraft(base({ name: "my.agent" }), { takenNames: new Set() })),
    ).toContain("name");
    expect(
      Object.keys(
        validateDraft(base({ name: "my.agent" }), { takenNames: new Set(), editing: true }),
      ),
    ).not.toContain("name");
  });

  test("edit mode still blocks a built-in name (no shadowing)", () => {
    expect(
      Object.keys(
        validateDraft(base({ name: "explore" }), { takenNames: new Set(), editing: true }),
      ),
    ).toContain("name");
  });

  test("emptyDraft seeds the example starter prompt", () => {
    expect(emptyDraft().body.length).toBeGreaterThan(0);
    expect(emptyDraft().tools).toContain("read");
  });
});
