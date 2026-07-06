import { describe, expect, test } from "bun:test";

import {
  detectMention,
  parseToken,
  filterCommands,
  filterSkills,
} from "@/lib/mention";
import type { SlashCommand } from "@/lib/types";

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

describe("parseToken (HOY-220, HOY-286)", () => {
  test("null / empty is the root menu, no file search", () => {
    expect(parseToken(null)).toEqual({ view: "root", q: "", wantFiles: false });
    expect(parseToken("")).toEqual({ view: "root", q: "", wantFiles: false });
  });

  test("@command: routes to the command view and skips the file search", () => {
    expect(parseToken("command:")).toEqual({
      view: "command",
      q: "",
      wantFiles: false,
    });
    expect(parseToken("command:git")).toEqual({
      view: "command",
      q: "git",
      wantFiles: false,
    });
  });

  test("category prefix is case-insensitive", () => {
    expect(parseToken("Command:X").view).toBe("command");
  });

  test("file and thread views are unchanged", () => {
    expect(parseToken("file:src")).toEqual({
      view: "file",
      q: "src",
      wantFiles: true,
    });
    expect(parseToken("thread:foo")).toEqual({
      view: "thread",
      q: "foo",
      wantFiles: false,
    });
  });

  test("an untyped token is a free search", () => {
    expect(parseToken("foo")).toEqual({
      view: "search",
      q: "foo",
      wantFiles: true,
    });
  });

  test("@skill: routes to the skill view (HOY-323)", () => {
    expect(parseToken("skill:")).toEqual({
      view: "skill",
      q: "",
      wantFiles: false,
    });
    expect(parseToken("skill:demo")).toEqual({
      view: "skill",
      q: "demo",
      wantFiles: false,
    });
  });
});

describe("filterSkills (HOY-323)", () => {
  const session: SlashCommand[] = [
    { name: "skill:demo-review", source: "skill" },
    { name: "skill:commit", source: "skill" },
    { name: "init", source: "extension" },
  ];

  test("returns only skills, matched by their bare name", () => {
    expect(filterSkills(session, "").map((c) => c.name)).toEqual([
      "skill:demo-review",
      "skill:commit",
    ]);
    expect(filterSkills(session, "demo").map((c) => c.name)).toEqual([
      "skill:demo-review",
    ]);
  });

  test("excludes non-skill commands even on a name match", () => {
    expect(filterSkills(session, "init")).toEqual([]);
  });
});

describe("filterCommands (HOY-286)", () => {
  const builtins: SlashCommand[] = [
    { name: "compact", source: "hoy" },
    { name: "init", source: "hoy" },
  ];
  const session: SlashCommand[] = [
    { name: "deploy", source: "extension" },
    { name: "skill:review", source: "skill" },
    // Collides with a built-in name: the built-in wins, this is dropped.
    { name: "init", source: "prompt" },
  ];

  test("merges built-ins and session commands, deduped by name", () => {
    const names = filterCommands(builtins, session, "").map((c) => c.name);
    expect(names).toEqual(["compact", "init", "deploy", "skill:review"]);
    // The built-in "init" survives, not the session "prompt" one.
    expect(filterCommands(builtins, session, "init")[0].source).toBe("hoy");
  });

  test("filters by a case-insensitive substring of the name", () => {
    expect(filterCommands(builtins, session, "DEP").map((c) => c.name)).toEqual([
      "deploy",
    ]);
  });

  test("query matches the full skill: prefixed name", () => {
    expect(
      filterCommands(builtins, session, "skill:rev").map((c) => c.name),
    ).toEqual(["skill:review"]);
  });

  test("no match yields an empty list", () => {
    expect(filterCommands(builtins, session, "zzz")).toEqual([]);
  });
});
