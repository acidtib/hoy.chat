// HOY-234 Phase 3: the subagent registry. Built-ins (code) + global + project
// `.hoy/agents/*.md` are parsed with Pi's parseFrontmatter, merged by precedence
// (builtin < global < project), tools validated and `agent` stripped (depth cap),
// and disabled state overlaid from subagents.json. The sidecar is the single
// parser; Rust reads this only via the one-shot list mode (hoy-sidecar.ts).
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
}

export type SubagentRegistry = Record<string, SubagentType>;

// The real registered built-in tool set (hoy-sidecar.ts HOY_TOOLS) minus `agent`
// (a child never spawns). `mcp` is included; unknown names in a .md are dropped.
export const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const GENERAL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const EXPLORE_TOOLS = ["read", "grep", "find", "ls"];

const EXPLORE_PROMPT = `You are Hoy running as an Explore subagent: a read-only investigator spawned by another agent to answer a focused question about this codebase.

Available tools: read, grep, find, ls. You have no write, edit, or bash access; do not ask for them.

Work: locate the relevant files, read what matters, and report concise findings with file paths and line numbers (for example src/main.rs:42). Do not speculate beyond what you read. Be direct; your response renders as markdown. Do not use emojis or em-dashes.`;

export const BUILTIN_SUBAGENTS: SubagentType[] = [
  { name: "general-purpose", scope: "builtin", tools: GENERAL_TOOLS, promptMode: "replace", enabled: true,
    description: "Full tool access. General coding and investigation." },
  { name: "Explore", scope: "builtin", tools: EXPLORE_TOOLS, promptMode: "replace", body: EXPLORE_PROMPT, enabled: true,
    description: "Read-only investigator (read, grep, find, ls)." },
];

interface AgentFrontmatter {
  description?: string;
  tools?: string[];
  prompt_mode?: string;
  model?: string;
  thinking?: string;
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
    enabled: true,
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

// The disabled name set from a scope's subagents.json ({ "disabled": [...] }).
function disabledSet(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = parsed && Array.isArray(parsed.disabled) ? parsed.disabled : [];
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
  // Overlay disabled state (global + project subagents.json). Project entry wins.
  const disabled = new Set<string>([
    ...disabledSet(join(agentDir, "subagents.json")),
    ...disabledSet(join(cwd, ".hoy", "subagents.json")),
  ]);
  for (const name of Object.keys(reg)) {
    if (disabled.has(name)) reg[name].enabled = false;
  }
  return reg;
}

export function enabledTypes(reg: SubagentRegistry): SubagentType[] {
  return Object.values(reg).filter((t) => t.enabled);
}
