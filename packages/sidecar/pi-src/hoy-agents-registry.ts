// HOY-234 Phase 3: the subagent registry. Built-ins (code) + global + project
// `.hoy/agents/*.md` are parsed with Pi's parseFrontmatter, merged by precedence
// (builtin < global < project), tools validated and `agent` stripped (depth cap),
// and disabled state overlaid from subagents.json. The sidecar is the single
// parser; Rust reads this only via the one-shot list mode (hoy-sidecar.ts).
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
}

export type SubagentRegistry = Record<string, SubagentType>;

// The real registered built-in tool set (hoy-sidecar.ts HOY_TOOLS) minus `agent`
// (a child never spawns). `mcp` is included; unknown names in a .md are dropped.
export const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const GENERAL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const EXPLORE_TOOLS = ["read", "grep", "find", "ls"];
// The Plan subagent (HOY-213) is read-only like Explore: it researches and
// designs, it does not implement. Matches Claude Code's Plan subagent (Write and
// Edit denied) and pi-subagents' planner (no bash).
const PLAN_TOOLS = ["read", "grep", "find", "ls"];

const EXPLORE_PROMPT = `You are Hoy running as an Explore subagent: a read-only investigator spawned by another agent to answer a focused question about this codebase.

Available tools: read, grep, find, ls. You have no write, edit, or bash access; do not ask for them.

Work: locate the relevant files, read what matters, and report concise findings with file paths and line numbers (for example src/main.rs:42). Do not speculate beyond what you read. Be direct; your response renders as markdown. Do not use emojis or em-dashes.`;

// The Plan architect subagent (HOY-213). Read-only research plus a
// decision-complete plan in the shared proposed_plan contract, so its delivered
// result is a plan the parent (or the handoff) can act on.
const PLAN_PROMPT = `You are Hoy running as the Plan subagent: a read-only software architect spawned to research this codebase and produce a decision-complete implementation plan. You do not implement anything, and you do not spawn further subagents; another agent or the user will execute your plan.

Available tools: read, grep, find, ls. You have no edit, write, or bash access; do not ask for them. Ground every claim in files you actually read, and cite paths with line numbers (for example src/main.rs:42). Do not use emojis or em-dashes.

Process:
1. Ground in the codebase. Read the files named in the task, find existing patterns and similar features, and trace the relevant code paths end to end. Prefer repository truth over assumption.
2. Design the solution. Choose an approach that follows the codebase's conventions, weigh the real tradeoffs, and name the one you picked and why. Identify dependencies and the order the work must happen in.
3. Produce the plan using the output contract below.

${PROPOSED_PLAN_FORMAT}`;

export const BUILTIN_SUBAGENTS: SubagentType[] = [
  { name: "general-purpose", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "replace", enabled: true,
    description: "Full tool access. General coding and investigation." },
  { name: "Explore", scope: "builtin", tools: EXPLORE_TOOLS, promptMode: "replace", body: EXPLORE_PROMPT, enabled: true,
    description: "Read-only investigator (read, grep, find, ls)." },
  { name: "Plan", scope: "builtin", tools: PLAN_TOOLS, promptMode: "replace", body: PLAN_PROMPT, enabled: true,
    description: "Read-only architect: researches the codebase and returns a decision-complete implementation plan." },
];

interface AgentFrontmatter {
  [key: string]: unknown;
  description?: string;
  tools?: string[];
  prompt_mode?: string;
  model?: string;
  thinking?: string;
  enabled?: boolean;
  inherit_context?: boolean;
}

// Intersect a declared tool list with KNOWN_TOOLS and drop `agent`. Omitted -> general set.
function validateTools(declared: unknown): string[] {
  if (!Array.isArray(declared)) return [...GENERAL_TOOLS];
  return declared.filter((t): t is string => typeof t === "string" && t !== "agent" && KNOWN_TOOLS.includes(t));
}

// Parse one .md into a SubagentType, or null if unreadable/malformed.
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
    // Frontmatter default (HOY-244): a type ships disabled with `enabled: false`;
    // anything else defaults on. The subagents.json overlay below can force it on
    // (the settings toggle) or off, overriding this default.
    enabled: fm.enabled !== false,
    inheritContext: fm.inherit_context === true,
  };
}

// All *.md in a directory as [name, path]; missing dir -> [].
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
  // Global then project files (later wins on name; winner's scope sticks).
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
  // frontmatter `enabled: false`), `disabled` forces it off; a name in neither
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

export function enabledTypes(reg: SubagentRegistry): SubagentType[] {
  return Object.values(reg).filter((t) => t.enabled);
}

// The child's system prompt given its type and the base Hoy prompt: replace uses
// the body verbatim, append concatenates onto the base, and no body inherits the
// base (general-purpose).
export function effectiveChildPrompt(type: SubagentType, basePrompt: string): string {
  if (!type.body) return basePrompt;
  return type.promptMode === "append" ? `${basePrompt}\n\n${type.body}` : type.body;
}
