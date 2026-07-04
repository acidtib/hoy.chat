import { test, expect } from "bun:test";
import {
  threadColorClass,
  threadColorIndex,
  threadIconColorClass,
} from "./threadColor";

test("threadColorIndex is deterministic and in range", () => {
  for (const id of ["", "a", "abc", "thread-123", crypto.randomUUID()]) {
    const idx = threadColorIndex(id);
    expect(idx).toBe(threadColorIndex(id));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(6);
  }
});

test("threadColorClass returns a thread palette class", () => {
  for (const id of ["", "x", "some-thread-id"]) {
    expect(threadColorClass(id)).toMatch(/^text-thread-[1-6]$/);
  }
});

test("distinct ids spread across the palette (not all one color)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(threadColorClass(`thread-${i}`));
  expect(seen.size).toBeGreaterThan(3);
});

test("threadIconColorClass keeps agent and active semantics", () => {
  expect(threadIconColorClass({ id: "z", active: false, isAgent: true })).toBe(
    "text-agent",
  );
  // Agent wins over active.
  expect(threadIconColorClass({ id: "z", active: true, isAgent: true })).toBe(
    "text-agent",
  );
  expect(threadIconColorClass({ id: "z", active: true, isAgent: false })).toBe(
    "text-brand",
  );
  // Idle threads get their stable hashed hue.
  expect(
    threadIconColorClass({ id: "z", active: false, isAgent: false }),
  ).toBe(threadColorClass("z"));
});
