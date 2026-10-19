// HOY-234 Phase 3: the subagent registry. Built-ins (code) + global + project
// `.hoy/agents/*.md` are parsed with Pi's parseFrontmatter, merged by precedence
// (builtin < global < project), tools validated and `agent` stripped (depth cap),
// and disabled state overlaid from subagents.json. The sidecar is the single
// parser. Rust reads this only via the one-shot list mode (hoy-sidecar.ts).
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type SubagentScope = "builtin" | "global" | "project";

export interface SubagentType {
  name: string;
  scope: SubagentScope;
  description?: string;
  tools: string[];
  promptMode: "replace" | "append";
  body?: string;
  model?: string;
  thinking?: string;
  source?: string;
  enabled: boolean;
  // HOY-244: opt a type into forking the parent's transcript at spawn instead of
  // starting fresh. Enforced at session creation in hoy-sidecar.ts.
  inheritContext?: boolean;
  // HOY-244: cap the type's turn budget (positive integer). Enforced by the
  // hoy-turn-budget extension, which aborts the run once the budget is spent.
  maxTurns?: number;
}

export type SubagentRegistry = Record<string, SubagentType>;

// The real registered built-in tool set (hoy-sidecar.ts HOY_TOOLS) minus `agent`
// (a child never spawns). `mcp` is included. Unknown names in a.md are dropped.
export const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const GENERAL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const READ_TOOLS = ["read", "grep", "find", "ls"];

// HOY-357: the shipped roster, one role each. Bodies append to the base Hoy
// prompt, so every role keeps the shared tool guidelines, safety and git rules.
const RESEARCHER_PROMPT = `## Role: Researcher
You explore the codebase, read documentation, investigate libraries, and gather evidence. You are read-only: your tools are read, grep, find, ls, and any MCP tools. You have no bash, edit, or write access in this role, whatever the tool list above says; do not ask for them.

How to work:
- Answer the question you were given, not a broader one. Read the files it names first, then trace the relevant code end to end.
- For a library, read its source and docs where they are installed (node_modules, vendored code, lockfiles) before relying on memory, and say which version you read.
- Report findings with evidence: file paths with line numbers (for example src/main.rs:42) and short quotes where they matter. Separate what you read from what you infer, and say what you could not find.`;

const WRITER_PROMPT = `## Role: Writer
You produce requirements documents, technical specifications, implementation documentation, and release notes. Your tools are read, grep, find, ls, edit, write, and any MCP tools. You have no bash access in this role; do not ask for it.

How to work:
- Ground every statement in the code or the source material you were given. Read before you write, and never document behavior you have not confirmed.
- Match the project's existing docs: location, format, headings, tone. Edit an existing document rather than starting a parallel one.
- Write for the reader who has to act on it: lead with what changes for them, keep it short, and cut anything that only narrates how the work was done.
- You write documents, not code. If the task needs a code change, say so instead of making it.`;

const CODER_PROMPT = `## Role: Coder
You own implementation: technical problem-solving, code changes, and fixing defects. You have the full tool set.

How to work:
- Understand before changing: read the code involved and find the existing pattern to follow. For a defect, reproduce it or find its cause before fixing it.
- Make the smallest change that fully solves the task, in the style of the surrounding code, with tests where the project has them.
- Verify your work with the project's own checks (its test, typecheck, and lint scripts), starting with the most specific one. Do not report a task done until those pass; if one fails for a reason outside your change, say so plainly.
- For a separate, self-contained research question, you may spawn a Researcher subagent instead of exploring it yourself.`;

const REVIEWER_PROMPT = `## Role: Reviewer
You are an independent peer reviewer: you check code quality, correctness, and potential regressions in a diff or pull request. Your tools are read, grep, find, ls, bash, and any MCP tools. You do not change the code under review: never edit or write files, and use bash only to inspect and verify (git diff, git log, git show, gh pr view, running tests and checks).

How to work:
- Start from the change itself (git diff against its base, or the pull request), then read enough surrounding code to judge it in context.
- Look for real defects first: wrong behavior, missed cases, broken callers, races, security problems, missing or weak tests. Then conventions and simplicity. Skip pure style preferences.
- Run the relevant tests or checks when they would confirm or rule out a suspected problem.
- Report each finding with its file and line, why it is wrong, and the concrete scenario where it fails, most severe first. If you find nothing worth fixing, say so plainly rather than inventing issues.`;

const PROJECT_MANAGER_PROMPT = `## Role: Project Manager
You own the backlog: you break requirements down into tasks, manage dependencies, prioritize, and track progress. Your tools are read, grep, find, ls, and any MCP tools, plus the Linear tools when this thread has them. You have no bash, edit, or write access in this role; you do not implement anything.

How to work:
- Read the code and existing issues enough to scope work accurately; do not plan against assumptions.
- Break work into issues an engineer or agent can pick up alone: a clear outcome, the scope in and out, and how to verify it. Keep each one small enough to finish in one sitting.
- Record dependencies and order explicitly (which issue blocks which), and set priorities that reflect them.
- Before filing new issues, check for existing ones that already cover the work, and update those instead of duplicating them.`;

export const BUILTIN_SUBAGENTS: SubagentType[] = [
  { name: "Researcher", scope: "builtin", tools: [...READ_TOOLS, "mcp"], promptMode: "append", body: RESEARCHER_PROMPT, enabled: true,
    description: "Explores the codebase, reads documentation, investigates libraries, and gathers evidence. Read-only." },
  { name: "Writer", scope: "builtin", tools: [...READ_TOOLS, "edit", "write", "mcp"], promptMode: "append", body: WRITER_PROMPT, enabled: true,
    description: "Produces requirements documents, technical specifications, implementation documentation, and release notes." },
  { name: "Coder", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "append", body: CODER_PROMPT, enabled: true,
    description: "Owns implementation, technical problem-solving, code changes, and fixing defects." },
  { name: "Reviewer", scope: "builtin", tools: [...READ_TOOLS, "bash", "mcp"], promptMode: "append", body: REVIEWER_PROMPT, enabled: true,
    description: "Independent peer reviewer: code quality, correctness, and regressions in a diff or pull request. Does not edit." },
  { name: "Project Manager", scope: "builtin", tools: [...READ_TOOLS, "mcp"], promptMode: "append", body: PROJECT_MANAGER_PROMPT, enabled: true,
    description: "Owns the backlog: breaks down requirements, manages dependencies, prioritizes tasks, tracks progress." },
];

// Types dropped from the roster (HOY-357) and what replaced them, so threads
// saved with an old type still reopen.
export const RETIRED_SUBAGENTS: Record<string, string> = {
  "general-purpose": "Coder",
  Explore: "Researcher",
  Plan: "Researcher",
};

interface AgentFrontmatter {
  [key: string]: unknown;
  description?: string;
  tools?: string[];
  prompt_mode?: string;
  model?: string;
  thinking?: string;
  enabled?: boolean;
  inherit_context?: boolean;
  max_turns?: number;
}

// Intersect a declared tool list with KNOWN_TOOLS and drop `agent`. Omitted -> general set.
function validateTools(declared: unknown): string[] {
  if (!Array.isArray(declared)) return [...GENERAL_TOOLS];
  return declared.filter((t): t is string => typeof t === "string" && t !== "agent" && KNOWN_TOOLS.includes(t));
}

// Parse one.md into a SubagentType, or null if unreadable/malformed.
function parseAgentFile(path: string, name: string, scope: SubagentScope): SubagentType | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let fm: AgentFrontmatter;
  let body: string;
  try {
    const parsed = parseFrontmatter<AgentFrontmatter>(raw);
    fm = parsed.frontmatter ?? {};
    body = parsed.body ?? "";
  } catch {
    return null;
  }
  const trimmed = body.trim();
  return {
    name,
    scope,
    description: typeof fm.description === "string" ? fm.description : undefined,
    tools: validateTools(fm.tools),
    promptMode: fm.prompt_mode === "append" ? "append" : "replace",
    body: trimmed.length > 0 ? trimmed : undefined,
    model: typeof fm.model === "string" ? fm.model : undefined,
    thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
    source: path,
    // Frontmatter default (HOY-244): a type ships disabled with `enabled: false`
    // anything else defaults on. The subagents.json overlay below can force it on
    // (the settings toggle) or off, overriding this default.
    enabled: fm.enabled !== false,
    inheritContext: fm.inherit_context === true,
    maxTurns:
      typeof fm.max_turns === "number" && fm.max_turns > 0 ? Math.floor(fm.max_turns) : undefined,
  };
}

// All *.md in a directory as [name, path]. Missing dir -> [].
function agentFiles(dir: string): Array<{ name: string; path: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ name: n.slice(0, -3), path: join(dir, n) }));
}

// A string-name set under `key` in a scope's subagents.json (e.g. "disabled" or
// "enabled"). Missing/malformed -> empty set.
function nameSet(path: string, key: "disabled" | "enabled"): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = parsed && Array.isArray(parsed[key]) ? parsed[key] : [];
    return new Set(list.filter((x: unknown): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function loadSubagentRegistry(agentDir: string, cwd: string): SubagentRegistry {
  const reg: SubagentRegistry = {};
  // Base layer: built-ins.
  for (const b of BUILTIN_SUBAGENTS) reg[b.name] = { ...b };
  // Global then project files (later wins on name. Winner's scope sticks).
  const layers: Array<{ dir: string; scope: SubagentScope }> = [
    { dir: join(agentDir, "agents"), scope: "global" },
    { dir: join(cwd, ".hoy", "agents"), scope: "project" },
  ];
  for (const { dir, scope } of layers) {
    for (const { name, path } of agentFiles(dir)) {
      const parsed = parseAgentFile(path, name, scope);
      if (parsed) reg[name] = parsed;
    }
  }
  // Overlay explicit enable/disable overrides from subagents.json, global then
  // project so the project scope wins. `enabled` forces a type on (overriding a
  // frontmatter `enabled: false`), `disabled` forces it off. A name in neither
  // keeps its frontmatter default. The settings toggle writes into these lists.
  for (const dir of [join(agentDir, "subagents.json"), join(cwd, ".hoy", "subagents.json")]) {
    const on = nameSet(dir, "enabled");
    const off = nameSet(dir, "disabled");
    for (const name of Object.keys(reg)) {
      if (on.has(name)) reg[name].enabled = true;
      else if (off.has(name)) reg[name].enabled = false;
    }
  }
  return reg;
}

// A type name as the registry knows it: itself, or its replacement when it was
// retired and no global or project file still defines it.
export function resolveSubagentName(reg: SubagentRegistry, name: string): string {
  return reg[name] ? name : (RETIRED_SUBAGENTS[name] ?? name);
}

export function enabledTypes(reg: SubagentRegistry): SubagentType[] {
  return Object.values(reg).filter((t) => t.enabled);
}

// The child's system prompt given its type and the base Hoy prompt: replace uses
// the body verbatim, append concatenates onto the base, and no body inherits the
// base.
export function effectiveChildPrompt(type: SubagentType, basePrompt: string): string {
  if (!type.body) return basePrompt;
  return type.promptMode === "append" ? `${basePrompt}\n\n${type.body}` : type.body;
}
