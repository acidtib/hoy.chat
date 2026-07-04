// HOY-265: the /init command. Covers hasRealContent's create-vs-update
// heuristic, the mode the handler picks against the filesystem, notify feedback,
// the idle/streaming sendUserMessage path, and the two prompt variants.
// Run with: bun test (in sidecar/pi-src)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoyInit, _internal, type InitMode } from "./hoy-init";

const { readIfExists, hasRealContent, buildInitPrompt } = _internal;

// A realistic hand-written AGENTS.md body, comfortably over the ~80-char bar.
const REAL_AGENTS = `# AGENTS.md

This is a Bun monorepo. Run everything from the root with the delegating scripts.

## Commands
- bun run test: run the suite.
`;

// Mount the factory against a fake pi, capturing the registered command and any
// injected user messages. Mirrors hoy-ask-question.test.ts's mount() helper.
function mount() {
  let command: any;
  const messages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const pi: any = {
    registerCommand: (name: string, spec: any) => (command = { name, ...spec }),
    registerTool: () => {},
    on: () => {},
    sendUserMessage: (content: string, options?: { deliverAs?: string }) =>
      messages.push({ content, options }),
  };
  createHoyInit()(pi);
  return { command, messages };
}

function makeCtx(cwd: string, idle = true) {
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx: any = {
    cwd,
    isIdle: () => idle,
    waitForIdle: async () => {},
    ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
  };
  return { ctx, notes };
}

describe("init command registration", () => {
  test("registers `init` with a description", () => {
    const { command } = mount();
    expect(command.name).toBe("init");
    expect(typeof command.description).toBe("string");
    expect(command.description.length).toBeGreaterThan(0);
    expect(typeof command.handler).toBe("function");
  });
});

describe("hasRealContent", () => {
  test.each([
    ["empty file", ""],
    ["whitespace only", "\n\n   \n"],
    ["heading only", "# AGENTS.md\n"],
    ["headings only", "# AGENTS.md\n\n## Commands\n\n## Testing\n"],
    ["html comment only", "<!-- generated placeholder, replace me -->\n"],
    ["bom + heading", "﻿# AGENTS.md\n"],
    ["short prose", "TODO: fill this in.\n"],
  ])("treats %s as scaffold (false)", (_label, input) => {
    expect(hasRealContent(input)).toBe(false);
  });

  test.each([
    ["real prose under headings", REAL_AGENTS],
    ["prose past a heading and comment", "# T\n<!-- x -->\n" + "a".repeat(90) + "\n"],
  ])("treats %s as real content (true)", (_label, input) => {
    expect(hasRealContent(input)).toBe(true);
  });
});

describe("handler mode selection", () => {
  function run(setup: (dir: string) => void, idle = true) {
    const dir = mkdtempSync(join(tmpdir(), "hoy-init-"));
    try {
      setup(dir);
      const { command, messages } = mount();
      const { ctx, notes } = makeCtx(dir, idle);
      return command.handler("", ctx).then(() => ({ messages, notes }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("no AGENTS.md picks create mode", async () => {
    const { messages, notes } = await run(() => {});
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Create an AGENTS.md");
    expect(messages[0].content).not.toContain("already has an AGENTS.md");
    expect(notes[0]).toEqual({ message: "Writing AGENTS.md...", type: "info" });
  });

  test("a real AGENTS.md picks update mode and asks to preserve human content", async () => {
    const { messages, notes } = await run((dir) =>
      writeFileSync(join(dir, "AGENTS.md"), REAL_AGENTS),
    );
    expect(messages[0].content).toContain("already has an AGENTS.md");
    expect(messages[0].content).toContain("Preserve human-authored content");
    expect(notes[0]).toEqual({ message: "Refreshing AGENTS.md...", type: "info" });
  });

  test("a heading-only AGENTS.md still picks create mode", async () => {
    const { messages } = await run((dir) =>
      writeFileSync(join(dir, "AGENTS.md"), "# AGENTS.md\n\n## Commands\n"),
    );
    expect(messages[0].content).toContain("Create an AGENTS.md");
  });

  test("idle sends immediately with no deliverAs; streaming queues as followUp", async () => {
    const idle = await run(() => {}, true);
    expect(idle.messages[0].options).toBeUndefined();

    const streaming = await run(() => {}, false);
    expect(streaming.messages[0].options).toEqual({ deliverAs: "followUp" });
  });
});

describe("buildInitPrompt", () => {
  const cwd = "/tmp/example-project";

  test.each<InitMode>(["create", "update"])("%s prompt carries the template and cwd", (mode) => {
    const prompt = buildInitPrompt(mode, cwd);
    expect(prompt).toContain("# AGENTS.md");
    expect(prompt).toContain("## Commands");
    expect(prompt).toContain("## Testing");
    expect(prompt).toContain(cwd);
    expect(prompt).toContain("Do not invent commands");
  });

  test("only the update prompt asks to preserve human-authored content", () => {
    expect(buildInitPrompt("update", cwd)).toContain("Preserve human-authored content");
    expect(buildInitPrompt("create", cwd)).not.toContain("Preserve human-authored content");
  });

  test("only the update prompt names the edit tool for targeted changes", () => {
    expect(buildInitPrompt("update", cwd)).toContain("Use the edit tool");
    expect(buildInitPrompt("create", cwd)).not.toContain("Use the edit tool");
  });
});

describe("readIfExists", () => {
  test("returns null for a missing file and the contents for an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoy-init-read-"));
    try {
      expect(readIfExists(join(dir, "nope.md"))).toBeNull();
      writeFileSync(join(dir, "AGENTS.md"), REAL_AGENTS);
      expect(readIfExists(join(dir, "AGENTS.md"))).toBe(REAL_AGENTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
