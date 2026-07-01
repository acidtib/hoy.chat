import { describe, expect, test } from "bun:test";

import { detectMention } from "@/lib/mention";

describe("detectMention (HOY-220)", () => {
  test("at the start of the value", () => {
    expect(detectMention("@fo", 3)).toEqual({ at: 0, query: "fo" });
  });

  test("after whitespace is a boundary", () => {
    expect(detectMention("hi @fo", 6)).toEqual({ at: 3, query: "fo" });
  });

  test("bare @ opens with an empty query", () => {
    expect(detectMention("@", 1)).toEqual({ at: 0, query: "" });
  });

  test("mid-word @ is not a mention (emails, handles)", () => {
    expect(detectMention("a@fo", 4)).toBeNull();
  });

  test("whitespace after the token closes the mention", () => {
    expect(detectMention("@fo bar", 7)).toBeNull();
  });

  test("no @ before the cursor", () => {
    expect(detectMention("hello", 5)).toBeNull();
  });

  test("query stops at the cursor, not the end of the value", () => {
    expect(detectMention("@abcd", 2)).toEqual({ at: 0, query: "a" });
  });
});
