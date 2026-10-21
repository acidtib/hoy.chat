// Asserts the system prompt pi actually assembles when the session is built
// the same way hoy-sidecar.ts builds it (systemPromptOverride replacement,
// noContextFiles, full built-in tool allowlist). Guards the HOY-185/186
// invariants: Hoy identity, no pi framing, no local package docs paths, pi's
// tool guidelines intact, GitHub docs pin, 7-tool list matching registration.
// Run with: bun test (in sidecar/pi-src)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildHoySystemPrompt,
  HOY_SYSTEM_PROMPT,
  PLAN_MODE_PROMPT,
  PROPOSED_PLAN_FORMAT,
  resolveRunContext,
} from "./hoy-system-prompt";

// Pi 1.3.0 edit guidelines (core/tools/edit.js). The prompt must carry these
// verbatim. Replacement strips pi's ability to inject them.
const PI_EDIT_GUIDELINES = [
  "Use edit for precise changes (edits[].oldText must match exactly)",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
];

const HOY_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

async function assembleSession(): Promise<{ prompt: string; toolNames: string[] }> {
  const agentDir = mkdtempSync(join(tmpdir(), "hoy-test-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "hoy-test-cwd-"));
  try {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noContextFiles: true,
        systemPromptOverride: () => HOY_SYSTEM_PROMPT,
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      tools: HOY_TOOLS,
    });
    return { prompt: session.systemPrompt, toolNames: session.getActiveToolNames() };
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("hoy system prompt assembly", () => {
  test("replacement prompt survives assembly with the Hoy invariants", async () => {
    const { prompt, toolNames } = await assembleSession();

    // Identity: Hoy, not pi.
    expect(prompt).toContain("You are Hoy, a coding agent running inside the Hoy desktop app.");
    expect(prompt).not.toContain("operating inside pi");
    expect(prompt).not.toContain("expert coding assistant");

    // Docs block points at the pinned GitHub tag, never at local package paths.
    expect(prompt).toContain(
      "https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/docs/extensions.md",
    );
    expect(prompt).not.toContain("node_modules");

    // Pi's edit guidelines survive verbatim.
    for (const guideline of PI_EDIT_GUIDELINES) {
      expect(prompt).toContain(guideline);
    }

    // Pi appends cwd as a <cwd> block (1.x); 0.80.7 dropped the current date.
    expect(prompt).not.toContain("Current date:");
    expect(prompt).toContain("<cwd>");

    // HOY-186: the prompt's tools list matches the registered set.
    for (const tool of HOY_TOOLS) {
      expect(prompt).toContain(`- ${tool}:`);
      expect(toolNames).toContain(tool);
    }
    expect(prompt).toContain("permission mode");
    expect(prompt).toContain("Prefer read, grep, find, and ls over their bash equivalents");

    // HOY-203: bash names its jobs, not the file ops the guidelines redirect.
    expect(prompt).toContain("bash: Execute bash commands (git, builds, tests, project scripts)");
    expect(prompt).toContain("issue the tool calls together in one message");
    expect(prompt).toContain("ask one short question instead of guessing");
    expect(prompt).toContain("Do not use emojis or em-dashes");

    // HOY-201: field-standard agentic rules. HOY-209 reworded the
    // ask-before-acting rule to "state intent, don't ask permission".
    expect(prompt).toContain("Keep working until the request is fully resolved");
    expect(prompt).toContain("Never revert or overwrite changes you did not make");
    expect(prompt).toContain("do not ask for permission before ordinary reads, searches, or edits");
    expect(prompt).toContain("src/main.rs:42");
    expect(prompt).toContain("Do not add tests to projects that have none");
    expect(prompt).toContain("git reset --hard");
  });
});

describe("plan mode: two-phase design gate (HOY-276 follow-up)", () => {
  test("the plan output contract leads with a Goal, like the superpowers format", () => {
    // HOY-276 parity: a plan must state its Goal (and Architecture) up front.
    expect(PROPOSED_PLAN_FORMAT).toContain("**Goal:**");
    expect(PROPOSED_PLAN_FORMAT).toContain("**Architecture:**");
    // Goal comes before everything else in the plan body.
    expect(PROPOSED_PLAN_FORMAT.indexOf("**Goal:**")).toBeLessThan(
      PROPOSED_PLAN_FORMAT.indexOf("## Approaches considered"),
    );
  });

  test("the plan output contract carries the design-rationale sections", () => {
    expect(PROPOSED_PLAN_FORMAT).toContain("## Approaches considered");
    expect(PROPOSED_PLAN_FORMAT).toContain("## Design rationale");
    // Design comes before the steps so a reviewer sees the "why" before the "what".
    expect(PROPOSED_PLAN_FORMAT.indexOf("## Approaches considered")).toBeLessThan(
      PROPOSED_PLAN_FORMAT.indexOf("## Steps"),
    );
  });

  test("the plan output contract carries optional per-task interface contracts (HOY-295)", () => {
    // HOY-295: for multi-file plans, a Global Constraints header plus per-step
    // Consumes/Produces contracts so steps can be handed to parallel subagents.
    expect(PROPOSED_PLAN_FORMAT).toContain("**Global Constraints:**");
    expect(PROPOSED_PLAN_FORMAT).toContain("Consumes:");
    expect(PROPOSED_PLAN_FORMAT).toContain("Produces:");
    // Global Constraints sits up top (after Tech Stack) before the steps. The
    // Consumes/Produces guidance lives in the Steps section.
    expect(PROPOSED_PLAN_FORMAT.indexOf("**Global Constraints:**")).toBeLessThan(
      PROPOSED_PLAN_FORMAT.indexOf("## Steps"),
    );
    expect(PROPOSED_PLAN_FORMAT.indexOf("Consumes:")).toBeGreaterThan(
      PROPOSED_PLAN_FORMAT.indexOf("## Steps"),
    );
  });

  test("plan mode instructs the approaches gate via a single ask_question call", () => {
    expect(PLAN_MODE_PROMPT).toContain("design gate");
    expect(PLAN_MODE_PROMPT).toContain("ask_question");
    expect(PLAN_MODE_PROMPT).toContain("2-3 genuinely distinct approaches");
    // The gate is skippable only for a genuinely trivial change.
    expect(PLAN_MODE_PROMPT).toContain("Only skip the gate for a genuinely trivial change");
    // ...and it must stop for the answer before emitting the plan.
    expect(PLAN_MODE_PROMPT).toContain("do NOT emit the proposed_plan block, until the user has answered");
  });
});

describe("resolveRunContext", () => {
  test("untyped threads are interactive", () => {
    expect(resolveRunContext({ hasType: false, depth: 0 })).toBe("interactive");
  });

  test("typed depth-0 threads are Fleet runs without the interactive flag", () => {
    expect(resolveRunContext({ hasType: true, depth: 0 })).toBe("fleet");
  });

  test("the interactive flag keeps a typed depth-0 thread interactive (HOY-385)", () => {
    expect(resolveRunContext({ hasType: true, depth: 0, interactiveAgent: true })).toBe("interactive");
  });

  test("typed children are subagents", () => {
    expect(resolveRunContext({ hasType: true, depth: 1 })).toBe("subagent");
  });
});

describe("buildHoySystemPrompt", () => {
  test("advertises the spawnable agent types dynamically", () => {
    expect(buildHoySystemPrompt()).not.toContain("Subagents:");
    const enabled = buildHoySystemPrompt({
      agentTypes: [
        { name: "Researcher", description: "read-only" },
        { name: "Reviewer", description: "reviews diffs" },
      ],
    });
    expect(enabled).toContain("Subagents:");
    expect(enabled).toContain("Researcher");
    expect(enabled).toContain("reviews diffs");
    // HOY-300: the agent tool is synchronous, the prompt tells the model the
    // call blocks and returns the subagent's result in-band (not "delivered back").
    expect(enabled).toContain("BLOCKS until the subagent finishes and returns its result");
    expect(enabled).toContain("has not seen this conversation");
    expect(enabled).not.toContain("Fire-and-forget");
  });

  test("lists only the session's tools and their guidelines (HOY-366)", () => {
    const readOnly = buildHoySystemPrompt({ tools: ["read", "grep", "find", "ls", "mcp"] });
    expect(readOnly).toContain("- read:");
    expect(readOnly).not.toContain("- bash:");
    expect(readOnly).not.toContain("- edit:");
    expect(readOnly).not.toContain("edits[].oldText");
    expect(readOnly).not.toContain("over their bash equivalents");
    const full = buildHoySystemPrompt({ tools: ["read", "bash", "edit", "write"] });
    expect(full).toContain("edits[].oldText");
    expect(full).toContain("over their bash equivalents");
  });

  test("restates the guidelines of Hoy's own tools, which pi drops on replacement", () => {
    const withTools = buildHoySystemPrompt({ tools: ["read", "ask_question", "linear_issue", "linear_comment"] });
    expect(withTools).toContain("read it with linear_issue first");
    expect(withTools).toContain("Group all of your clarifying questions into a single ask_question call");
    const without = buildHoySystemPrompt({ tools: ["read"] });
    expect(without).not.toContain("linear_issue");
    expect(without).not.toContain("ask_question call");
  });

  test("states the run context: interactive, Fleet, or subagent (HOY-366)", () => {
    expect(buildHoySystemPrompt()).toContain("You are working with the user directly");
    expect(buildHoySystemPrompt({ run: "fleet" })).toContain("assigned this task from the Fleet");
    const sub = buildHoySystemPrompt({ run: "subagent" });
    expect(sub).toContain("You are a subagent");
    expect(sub).toContain("only thing it receives");
  });

  test("carries no Hoy MCP block; Pi's mcp_servers section describes servers", () => {
    expect(buildHoySystemPrompt({ agentTypes: [] })).not.toContain("MCP tools:");
  });

  test("points at Pi-appended skills and MCP sections so the model checks them unprompted", () => {
    const prompt = buildHoySystemPrompt();
    expect(prompt).toContain("Skills and MCP:");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<mcp_servers>");
    expect(prompt).toContain("tool_search");
    expect(prompt).toContain("when any MCP servers are configured");
    expect(prompt).toContain("Do not wait for the user to name the server or tool.");
    expect(prompt).toContain("Do not wait for the user to name the skill.");
  });

  test("omits the MCP line when the session has no MCP tools", () => {
    const prompt = buildHoySystemPrompt({ tools: ["read", "bash", "edit", "write"] });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).not.toContain("<mcp_servers>");
  });

  test("omits the discovery block when the session has neither a reader nor MCP", () => {
    expect(buildHoySystemPrompt({ tools: [] })).not.toContain("Skills and MCP:");
  });

  test("the no-em-dash rule covers text posted outside the app", () => {
    expect(buildHoySystemPrompt()).toContain("comments you post to Linear or GitHub");
  });

  test("uses no em dashes", () => {
    expect(buildHoySystemPrompt({ run: "subagent", agentTypes: [{ name: "X" }] })).not.toContain("\u2014");
  });
});
