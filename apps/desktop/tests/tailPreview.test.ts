import { describe, expect, test } from "bun:test";
import { tailOf } from "@/components/TailPreview";

describe("tailOf", () => {
  test("keeps the last lines and drops trailing blank lines", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n\n";
    expect(tailOf(text).split("\n")).toEqual(
      Array.from({ length: 8 }, (_, i) => `line ${i + 12}`),
    );
  });

  test("caps a single long line to its end", () => {
    const text = "x".repeat(5000) + "end";
    const tail = tailOf(text);
    expect(tail.length).toBe(1200);
    expect(tail.endsWith("end")).toBe(true);
  });
});
