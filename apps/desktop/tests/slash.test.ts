import { describe, expect, test } from "bun:test";

import { detectSlash } from "@/lib/slash";

describe("detectSlash (HOY-223)", () => {
  test("leading / at message start returns the query", () => {
    expect(detectSlash("/foo", 4)).toEqual({ query: "foo" });
  });

  test("bare / opens with an empty query", () => {
    expect(detectSlash("/", 1)).toEqual({ query: "" });
  });

  test("query stops at the cursor, not the end of the value", () => {
    expect(detectSlash("/compact", 3)).toEqual({ query: "co" });
  });

  test("/ not at the start returns null", () => {
    expect(detectSlash("hi /foo", 7)).toBeNull();
  });

  test("whitespace before the / returns null", () => {
    expect(detectSlash(" /foo", 5)).toBeNull();
  });

  test("caret past the first token returns null", () => {
    expect(detectSlash("/foo bar", 8)).toBeNull();
  });

  test("no leading / returns null", () => {
    expect(detectSlash("hello", 5)).toBeNull();
  });
});
