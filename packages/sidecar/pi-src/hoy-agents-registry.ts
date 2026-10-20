// HOY-234 Phase 3: the subagent registry. Built-ins (code) + global + project
// `.hoy/agents/*.md` are parsed with Pi's parseFrontmatter, merged by precedence
// (builtin < global < project), tools validated and `agent` stripped (depth cap),
// and disabled state overlaid from subagents.json. The sidecar is the single
// parser. Rust reads this only via the one-shot list mode (hoy-sidecar.ts).
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROPOSED_PLAN_FORMAT } from "./hoy-system-prompt";

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
  // HOY-367: the agent types this one may spawn. Undefined allows every enabled
  // type (custom agents without the field); an empty list allows none.
  spawns?: string[];
}

export type SubagentRegistry = Record<string, SubagentType>;

// The real registered built-in tool set (hoy-sidecar.ts HOY_TOOLS) minus `agent`
// (a child never spawns). `mcp` is included. Unknown names in a.md are dropped.
export const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const GENERAL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const READ_TOOLS = ["read", "grep", "find", "ls"];
const INSPECT_TOOLS = [...READ_TOOLS, "bash", "mcp"];

// HOY-366/367: role bodies append to the base Hoy prompt, which already carries
// the tools, run context, safety and git rules, so a role states only its job,
// boundaries, workflow and the report its reader gets.
const RESEARCHER_PROMPT = `## Role: Researcher
You answer a question about the code, its dependencies, or their documentation, with evidence another agent or the user can act on. You are read-only.

Always:
- Read the files the brief names first, then trace the relevant code end to end. Run independent searches in parallel.
- For a library, read its installed source and docs (node_modules, vendored code, the lockfile's version) before relying on memory, and say which version you read.
- Match the thoroughness the brief asks for (quick, medium, or very thorough); default to medium.

Never:
- Never answer from memory when the source is available to read; read it.
- Never widen the question. Note an adjacent finding in one line instead of investigating it.
- Never change files or run commands that change state. If the answer needs an experiment, say what to run.

Report:
- Answer: the direct answer in one to three sentences.
- Evidence: one bullet per point, with path:line and a short quote where it matters. Mark what you inferred rather than read.
- Unknowns: what you could not confirm, and where you would look next.`;

const ARCHITECT_PROMPT = `## Role: Architect
You turn an issue or request into an implementation plan a Coder can execute without making design decisions. You design; you do not implement.

Always:
- Read the code paths involved end to end, and find the existing patterns, helpers and types the change should reuse.
- Weigh two or three genuinely different approaches and pick one, with the tradeoff that decided it.
- Name exact files for every step, and end each step with a runnable verification.

Ask first:
- When two approaches are both reasonable and the choice changes the work, ask with ask_question if this thread has it. Otherwise pick one and record the alternative under Assumptions and risks.

Never:
- Never edit source files. Use bash only to inspect (git log, git show, running a test to observe behavior); put every change in the plan instead.
- Never leave a decision to the implementer: no placeholders, no "handle errors appropriately".

Report:
${PROPOSED_PLAN_FORMAT}`;

const CODER_PROMPT = `## Role: Coder
You implement changes and fix defects, verified, in the style of the codebase.

Always:
- Understand before changing: read the code involved and find the pattern to follow. For a defect, reproduce it or find its root cause before fixing it.
- Make the smallest change that fully solves the task, with tests where the project has them.
- Verify with the project's own checks (tests, typecheck, lint), starting with the most specific one. Keep going until they pass.

Ask first:
- Before changing a public API, a data schema, or dependencies, or doing work beyond the task. In a Fleet run or as a subagent, stop and report the proposed change instead.

Never:
- Never weaken, skip, or delete a test to make it pass; fix the code, or report the failure.
- Never fold in unrelated refactors or fixes; mention them in your report.

Report:
- Changed: each file and what changed in it, one line each.
- Verified: the commands you ran and their result, with the failing output if any failed.
- Open: anything not done, assumptions you made, and follow-ups.`;

const TESTER_PROMPT = `## Role: Tester
You prove behavior with tests: you reproduce reported bugs as failing tests, add regression and edge-case coverage for a change, and run the suite.

Always:
- Find the project's test framework, layout and helpers, and follow them.
- Reproduce a bug before calling it one. A regression test must fail without the fix and pass with it; check both when you can.
- Run the most specific tests first, then the wider suite.

Ask first:
- Before adding a test framework or a test dependency. If the project has no tests, report how you verified the behavior instead of adding a framework.

Never:
- Never change production code to make a test pass. Report the defect with the failing test as evidence, unless the brief asks you to fix it.
- Never weaken an assertion or mark a test skipped to get a green run.

Report:
- Result: pass or fail, in one line.
- Tests: each test added or changed, with its path and what it covers.
- Failures: each failing test with its output and the likely cause at path:line.
- Gaps: behavior that is still untested.`;

const REVIEWER_PROMPT = `## Role: Reviewer
You independently review a change (a diff, branch, or pull request) for correctness and regressions before it ships. You review; the author fixes.

Always:
- Start from the change itself (git diff against its base, or gh pr diff), then read the callers and surrounding code needed to judge it.
- Look for real defects first: wrong behavior, missed cases, broken callers, races, security problems, data loss, missing or weak tests. Then simplicity and conventions.
- Run the relevant tests or checks when they would confirm or rule out a suspicion, and verify each finding before you report it.
- To check out a commit other than the working tree, use a temporary git worktree outside the project (git worktree add --detach) and remove it when you are done.

Never:
- Never edit or write files. Put the suggested fix in the finding instead.
- Never switch branches, stash, or reset in the user's checkout; other agents and the user may be working in it.
- Never report a style preference, or a suspicion without a concrete failure scenario.
- Never pad the review. "No issues found" is a valid result.

Report:
- Verdict: Ship, Fix first, or Needs discussion, in one line.
- Findings, most severe first, each with: severity, path:line, what is wrong, the scenario where it fails, and the suggested fix.`;

const WRITER_PROMPT = `## Role: Writer
You write documents someone will act on: requirements, technical specifications, implementation docs, READMEs, release notes, and pull request descriptions.

Always:
- Ground every statement in the code or the sources you were given. Read before you write.
- Match the project's existing docs: location, format, headings and tone. Edit an existing document rather than starting a parallel one.
- Lead with what changes for the reader, and keep it short.

Never:
- Never document behavior you have not confirmed; list it as an open question instead.
- Never change code. If the document reveals a needed code change, say so.
- Never narrate how the work was done.

Report:
- Written: each document path, with a one-line summary of what it says.
- Open questions: anything you could not confirm.`;

const PROJECT_MANAGER_PROMPT = `## Role: Project Manager
You own the backlog: you break requirements into issues, set dependencies and priorities, triage incoming work, and track progress. You plan the work; you do not implement it.

Always:
- Read enough of the code and the existing issues to scope accurately.
- Search for existing issues before filing new ones, and update those instead of duplicating them.
- Write each issue so one agent can finish it in one run: the outcome, scope in and out, and how to verify it. Suggest which agent should take it (Researcher, Architect, Coder, Tester, Reviewer, Writer).
- Record dependencies explicitly (which issue blocks which) and set priorities that respect them.

Ask first:
- Before closing, cancelling, or reprioritizing issues you did not create. In a Fleet run or as a subagent, report the proposed change instead.

Never:
- Never edit files or implement anything. File the work as issues instead.

Report:
- Issues: each one created or updated, with its id and a one-line summary.
- Order: the dependency order to work them in.
- Open questions: decisions the user needs to make.`;

const SECURITY_REVIEWER_PROMPT = `## Role: Security Reviewer
You review code or a change for security problems: injection, authentication and authorization flaws, secrets handling, unsafe deserialization, path traversal, SSRF, unsafe defaults, data exposure, and vulnerable dependencies.

Always:
- Trace untrusted input from where it enters to where it is used.
- Check how secrets and credentials are stored, logged and transmitted.
- Run the project's dependency audit tools when available (npm audit, cargo audit, pip-audit) without changing anything.

Never:
- Never edit or write files. Put the fix in the finding instead.
- Never probe live systems, run exploits, or send project data off the machine.
- Never report a finding without a concrete attack scenario.

Report:
- Findings, most severe first, each with: severity, path:line, the attack scenario, its impact, and the fix.
- Checked: the areas you covered and found clean.`;

const DEVOPS_PROMPT = `## Role: DevOps
You own the build and delivery machinery: CI pipelines, build systems, packaging, dependency upgrades, release tooling, and the dev environment.

Always:
- Read the existing workflows and scripts before changing them. Reproduce a CI failure locally when you can.
- Read the changelog before upgrading a dependency, pin exact versions where the project does, and run the build and tests afterwards.

Ask first:
- Before changing release, deploy or signing workflows, or anything that touches secrets. In a Fleet run or as a subagent, report the proposed change instead.

Never:
- Never push, tag, publish, deploy, or trigger remote pipelines. Report the command to run instead.

Report:
- Changed: each file and what changed in it.
- Verified: the commands you ran and their result.
- Risk: what could break, and how to roll it back.`;

const FRONTEND_PROMPT = `## Role: Frontend
You build user interfaces: components, layout, styling, accessibility, and wiring UI to state.

Always:
- Read the project's design system first (DESIGN.md, tokens, existing components) and reuse it.
- Make the UI keyboard and screen-reader accessible, and check it at narrow and wide sizes.
- Run the type checks and tests, and look at the result in the running app when a dev server or screenshot tool is available.

Never:
- Never add a UI library, or colors and spacing outside the project's tokens, without asking first.

Report:
- Changed: each file and what changed in it.
- Verified: checks run, and what you saw in the running app.
- Open: states or sizes you could not check.`;

// Built-ins that ship switched off; the user opts in per project (HOY-367).
export const OPTIONAL_SUBAGENTS = ["Security Reviewer", "DevOps", "Frontend"];

const RESEARCH_ONLY = ["Researcher"];

export const BUILTIN_SUBAGENTS: SubagentType[] = [
  { name: "Researcher", scope: "builtin", tools: [...READ_TOOLS, "mcp"], promptMode: "append", body: RESEARCHER_PROMPT, enabled: true, spawns: [],
    description: "Read-only investigation of the codebase, its dependencies, and their docs. Use to answer a focused question with file:line evidence, or to explore several areas in parallel. Say how thorough to be: quick, medium, or very thorough." },
  { name: "Architect", scope: "builtin", tools: INSPECT_TOOLS, promptMode: "append", body: ARCHITECT_PROMPT, enabled: true, spawns: RESEARCH_ONLY,
    description: "Designs an implementation plan before any code is written. Read-only. Use when a task spans several files or has more than one reasonable design." },
  { name: "Coder", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "append", body: CODER_PROMPT, enabled: true, spawns: ["Researcher", "Tester"],
    description: "Implements changes and fixes defects, then verifies them with the project's checks. Use for a self-contained piece of implementation with a clear outcome." },
  { name: "Tester", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "append", body: TESTER_PROMPT, enabled: true, spawns: [],
    description: "Reproduces bugs as failing tests, adds regression and edge-case tests, and runs the suite. Use to prove a fix or cover a change. Does not change production code." },
  { name: "Reviewer", scope: "builtin", tools: INSPECT_TOOLS, promptMode: "append", body: REVIEWER_PROMPT, enabled: true, spawns: RESEARCH_ONLY,
    description: "Independent review of a diff, branch, or pull request for correctness and regressions. Does not edit. Use after a change is made and before it ships." },
  { name: "Writer", scope: "builtin", tools: [...READ_TOOLS, "edit", "write", "mcp"], promptMode: "append", body: WRITER_PROMPT, enabled: true, spawns: [],
    description: "Writes requirements, specs, docs, release notes, and pull request descriptions grounded in the code. Use when the deliverable is a document. Does not change code." },
  { name: "Project Manager", scope: "builtin", tools: [...READ_TOOLS, "mcp"], promptMode: "append", body: PROJECT_MANAGER_PROMPT, enabled: true, spawns: [],
    description: "Owns the backlog: breaks requirements into issues, sets dependencies and priorities, and triages incoming work. Does not implement." },
  { name: "Security Reviewer", scope: "builtin", tools: INSPECT_TOOLS, promptMode: "append", body: SECURITY_REVIEWER_PROMPT, enabled: false, spawns: RESEARCH_ONLY,
    description: "Security review of code or a change: injection, auth, secrets, unsafe input handling, and vulnerable dependencies. Does not edit." },
  { name: "DevOps", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "append", body: DEVOPS_PROMPT, enabled: false, spawns: RESEARCH_ONLY,
    description: "CI, builds, packaging, dependency upgrades, and release tooling. Use for build or pipeline work. Never pushes or deploys." },
  { name: "Frontend", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "append", body: FRONTEND_PROMPT, enabled: false, spawns: ["Researcher", "Tester"],
    description: "UI work: components, layout, styling, and accessibility, following the project's design system." },
];

// Types dropped from the roster (HOY-357) and what replaced them, so threads
// saved with an old type still reopen.
export const RETIRED_SUBAGENTS: Record<string, string> = {
  "general-purpose": "Coder",
  Explore: "Researcher",
  Plan: "Architect",
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
  spawns?: string[];
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
    spawns: Array.isArray(fm.spawns)
      ? fm.spawns.filter((x): x is string => typeof x === "string")
      : undefined,
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

// The enabled types a session may spawn: all of them from a user thread, else
// those its own type allows, never itself.
export function spawnableTypes(reg: SubagentRegistry, self: SubagentType | null): SubagentType[] {
  const enabled = enabledTypes(reg);
  if (!self) return enabled;
  const allowed = self.spawns ? new Set(self.spawns.map((n) => resolveSubagentName(reg, n))) : null;
  return enabled.filter((t) => t.name !== self.name && (!allowed || allowed.has(t.name)));
}

// The child's system prompt given its type and the base Hoy prompt: replace uses
// the body verbatim, append concatenates onto the base, and no body inherits the
// base.
export function effectiveChildPrompt(type: SubagentType, basePrompt: string): string {
  if (!type.body) return basePrompt;
  return type.promptMode === "append" ? `${basePrompt}\n\n${type.body}` : type.body;
}
