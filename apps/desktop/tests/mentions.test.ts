import { describe, expect, test } from "bun:test";
import {
  draftContexts,
  draftIsEmpty,
  draftToMessage,
  draftToParts,
  mentionMarker,
} from "@/lib/mentions";

const fileRef = { kind: "file" as const, path: "src/a.ts", name: "a.ts" };
const dirRef = { kind: "directory" as const, path: "src", name: "src" };
const threadRef = { kind: "thread" as const, threadId: "t2", title: "Other" };

describe("draft mentions (HOY-220)", () => {
  test("round-trips text and a mention through parts", () => {
    const draft = `hi ${mentionMarker(fileRef)} bye`;
    expect(draftToParts(draft)).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", ref: fileRef },
      { type: "text", text: " bye" },
    ]);
  });

  test("draftToMessage replaces markers with labels", () => {
    const draft = `see ${mentionMarker(fileRef)} and ${mentionMarker(threadRef)}`;
    expect(draftToMessage(draft)).toBe("see a.ts and Other");
  });

  test("draftContexts returns unique refs in order", () => {
    const draft = `${mentionMarker(fileRef)} ${mentionMarker(dirRef)} ${mentionMarker(fileRef)}`;
    expect(draftContexts(draft)).toEqual([fileRef, dirRef]);
  });

  test("plain text has no mentions", () => {
    expect(draftToParts("hello")).toEqual([{ type: "text", text: "hello" }]);
    expect(draftToMessage("hello")).toBe("hello");
    expect(draftContexts("hello")).toEqual([]);
  });

  test("draftIsEmpty is true for blank text, false with a mention", () => {
    expect(draftIsEmpty("")).toBe(true);
    expect(draftIsEmpty("   ")).toBe(true);
    expect(draftIsEmpty("hi")).toBe(false);
    expect(draftIsEmpty(mentionMarker(fileRef))).toBe(false);
  });
});
