import { describe, expect, test } from "bun:test";

import { parseSkillBlock, rewriteSkillCommand } from "@/lib/skill";
import type { SlashCommand } from "@/lib/types";

describe("parseSkillBlock (HOY-323)", () => {
  test("parses a skill block with no user message", () => {
    const text =
      '<skill name="commit-helper" location="/home/u/.hoy/skills/commit-helper/SKILL.md">\n' +
      "References are relative to /home/u/.hoy/skills/commit-helper.\n\n" +
      "Write a conventional commit.\n" +
      "</skill>";
    const parsed = parseSkillBlock(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("commit-helper");
    expect(parsed!.location).toBe("/home/u/.hoy/skills/commit-helper/SKILL.md");
    expect(parsed!.content).toContain("Write a conventional commit.");
    expect(parsed!.userMessage).toBeUndefined();
  });

  test("parses a trailing user message after the block", () => {
    const text =
      '<skill name="review" location="/x/SKILL.md">\nbody line\n</skill>\n\n' +
      "please review src/main.ts";
    const parsed = parseSkillBlock(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.content).toBe("body line");
    expect(parsed!.userMessage).toBe("please review src/main.ts");
  });

  test("returns null for plain text", () => {
    expect(parseSkillBlock("just a normal message")).toBeNull();
  });

  test("returns null when the block is not at the start", () => {
    expect(
      parseSkillBlock('hello <skill name="x" location="/x">\nbody\n</skill>'),
    ).toBeNull();
  });

  test("returns null for an unclosed block", () => {
    expect(parseSkillBlock('<skill name="x" location="/x">\nbody')).toBeNull();
  });
});

describe("rewriteSkillCommand (HOY-323)", () => {
  const commands: SlashCommand[] = [
    { name: "skill:demo-review", source: "skill" },
    { name: "skill:commit", source: "skill" },
    { name: "init", source: "extension" },
  ];

  test("rewrites a bare skill command to the /skill: form", () => {
    expect(rewriteSkillCommand("/demo-review", commands)).toBe(
      "/skill:demo-review",
    );
  });

  test("preserves trailing args when rewriting", () => {
    expect(rewriteSkillCommand("/demo-review src/a.ts", commands)).toBe(
      "/skill:demo-review src/a.ts",
    );
  });

  test("leaves an unknown command untouched", () => {
    expect(rewriteSkillCommand("/unknown thing", commands)).toBe(
      "/unknown thing",
    );
  });

  test("does not rewrite a name shadowed by a non-skill command", () => {
    const shadowed: SlashCommand[] = [
      { name: "skill:init", source: "skill" },
      { name: "init", source: "extension" },
    ];
    expect(rewriteSkillCommand("/init", shadowed)).toBe("/init");
  });

  test("leaves an already-prefixed /skill: command untouched", () => {
    expect(rewriteSkillCommand("/skill:demo-review", commands)).toBe(
      "/skill:demo-review",
    );
  });

  test("leaves plain prose untouched", () => {
    expect(rewriteSkillCommand("just a message", commands)).toBe(
      "just a message",
    );
  });
});
