# Subagents Phase 3 (agent-type registry + safety) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hardcoded subagent built-ins with a file-based registry (`.hoy/agents/*.md`), gated by project trust, with a settings UI, keeping the two built-ins as the always-present base layer.

**Architecture:** The sidecar is the single registry parser: `loadSubagentRegistry` reads in-code built-ins + global `<agentDir>/agents/*.md` + project `<cwd>/.hoy/agents/*.md`, parses frontmatter with Pi's `parseFrontmatter`, merges by precedence (builtin < global < project), validates tools (stripping `agent` for the depth cap), and overlays disabled state from `subagents.json`. Runtime consumers (the parent's `agent` tool advertise/validate/trust-gate, and the child factory's tools+prompt) use it directly; a one-shot `HOY_LIST_SUBAGENTS` mode prints the resolved registry as JSON for the settings UI. Rust owns only `subagents.json` (JSON enable/disable) and the spawn+capture of the one-shot. The renderer caches the list and applies a child type's model/thinking via the proven `applyThreadModel` path.

**Tech Stack:** Pi sidecar (TypeScript, `bun test`, Pi's `parseFrontmatter`), Tauri v2 Rust (`serde_json`, no new deps), React + Zustand renderer (`bun test`, `bun run check:ts`), shadcn settings UI.

## Global Constraints

- No emojis, no em-dashes anywhere (code, comments, docs, commits). Use a comma, semicolon, or separate sentences.
- Plain git commit messages, `HOY-234:` prefix, no Co-Authored-By trailers.
- No new Rust or npm dependencies. Rust stays `serde_json`-only (NO `serde_yaml`). Do NOT install or wire the Vercel AI SDK.
- Frontmatter is parsed ONLY in the sidecar via Pi's `parseFrontmatter` (`@earendil-works/pi-coding-agent`). Rust never parses `.md`.
- Depth cap is absolute: `agent` is stripped from every registry entry's tools; a `.md` file can never grant a child the `agent` tool.
- The two built-ins keep their exact Phase-1 behavior: `general-purpose` = tools `["read","grep","find","ls","bash","edit","write","mcp"]`, inherits the base Hoy prompt (no body); `Explore` = tools `["read","grep","find","ls"]`, body = the existing `EXPLORE_PROMPT`, `promptMode` replace.
- Project-scope agents are trust-gated in the `agent` tool's `execute()` (has `ctx`), never at load time: `if (type.scope === "project" && !ctx.isProjectTrusted()) throw`.
- The branded project dir is `.hoy` (unconditional, even in debug); the global agents dir is `<PI_CODING_AGENT_DIR>/agents` (Rust passes `PI_CODING_AGENT_DIR`, which is `~/.hoy/agent` or `~/.hoyd/agent` in debug).
- Rebuild the sidecar (`packages/sidecar/build.sh`) before any live verification (HOY-200).

## Shared Interfaces (defined in Task 1, used everywhere)

```ts
// hoy-agents-registry.ts
export type SubagentScope = "builtin" | "global" | "project";

export interface SubagentType {
  name: string;
  scope: SubagentScope;
  description?: string;
  tools: string[];                       // validated, `agent` stripped
  promptMode: "replace" | "append";      // meaningful only when body is set
  body?: string;                         // markdown body; undefined = inherit base prompt
  model?: string;
  thinking?: string;
  source?: string;                       // file path; undefined for built-ins
  enabled: boolean;                      // false when named in subagents.json disabled
}

export type SubagentRegistry = Record<string, SubagentType>;
```

The one-shot list mode and the renderer share this JSON shape (a `SubagentDef`):
`{ name, scope, description|null, tools, promptMode, model|null, thinking|null, source|null, enabled }`.

---

## File Structure

- `packages/sidecar/pi-src/hoy-agents-registry.ts` (new) - the loader + built-ins + validation (Task 1).
- `packages/sidecar/pi-src/hoy-agents.ts` - dynamic param, registry-driven `execute()`, trust gate (Task 2).
- `packages/sidecar/pi-src/hoy-system-prompt.ts` - `buildHoySystemPrompt` takes the type list (Task 2).
- `packages/sidecar/pi-src/hoy-sidecar.ts` - factory uses the registry + prompt composition + one-shot list mode (Task 3).
- `apps/desktop/src-tauri/src/subagents_config.rs` (new) - `subagents.json` enable/disable (Task 4).
- `apps/desktop/src-tauri/src/sidecar.rs` - one-shot spawn+capture method (Task 5).
- `apps/desktop/src-tauri/src/commands.rs` + `lib.rs` - the two commands + registration (Task 5).
- `apps/desktop/src/lib/ipc.ts` + `lib/types.ts` - wrappers + `SubagentDef` (Task 6).
- `apps/desktop/src/state/store.ts` - registry cache + model application in `spawnChildThread` (Task 6).
- `apps/desktop/src/components/settings/SubagentsPanel.tsx` (new) + `categories.ts` + `panels.tsx` (Task 7).

---

### Task 1: Sidecar registry loader (`hoy-agents-registry.ts`)

**Files:**
- Create: `packages/sidecar/pi-src/hoy-agents-registry.ts`
- Create: `packages/sidecar/pi-src/hoy-agents-registry.test.ts`

**Interfaces:**
- Consumes: Pi's `parseFrontmatter<T>(content: string): { frontmatter: T; body: string }` from `@earendil-works/pi-coding-agent`; `readFileSync`, `readdirSync` from `node:fs`; `join` from `node:path`.
- Produces: `SubagentScope`, `SubagentType`, `SubagentRegistry` (above); `BUILTIN_SUBAGENTS: SubagentType[]`; `KNOWN_TOOLS: string[]`; `loadSubagentRegistry(agentDir: string, cwd: string, env?): SubagentRegistry`; `enabledTypes(reg): SubagentType[]`.

- [ ] **Step 1: Write the failing tests** (`hoy-agents-registry.test.ts`)

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentRegistry, enabledTypes, BUILTIN_SUBAGENTS } from "./hoy-agents-registry";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hoy-agents-"));
}
function writeAgent(dir: string, name: string, frontmatter: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

test("built-ins are always present with Phase-1 tool sets", () => {
  const reg = loadSubagentRegistry(tmp(), tmp());
  expect(reg["general-purpose"].tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"]);
  expect(reg["general-purpose"].body).toBeUndefined();
  expect(reg["Explore"].tools).toEqual(["read", "grep", "find", "ls"]);
  expect(reg["Explore"].body).toContain("read-only");
  expect(reg["Explore"].promptMode).toBe("replace");
});

test("project overrides global overrides built-in by name; scope reflects the winner", () => {
  const agentDir = tmp();
  const cwd = tmp();
  writeAgent(join(agentDir, "agents"), "Explore", "description: global explore", "global body");
  writeAgent(join(cwd, ".hoy", "agents"), "Explore", "description: project explore", "project body");
  const reg = loadSubagentRegistry(agentDir, cwd);
  expect(reg["Explore"].scope).toBe("project");
  expect(reg["Explore"].description).toBe("project explore");
  expect(reg["Explore"].body).toBe("project body");
});

test("agent is stripped from a type's tools (depth cap) and unknown tools dropped", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Bad", "tools: [read, agent, bogus, bash]", "b");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Bad"].tools).toEqual(["read", "bash"]);
});

test("prompt_mode defaults to replace and parses append", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "App", "prompt_mode: append", "x");
  writeAgent(join(cwd, ".hoy", "agents"), "Def", "description: d", "y");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["App"].promptMode).toBe("append");
  expect(reg["Def"].promptMode).toBe("replace");
});

test("model and thinking are parsed; tools omitted defaults to the general set", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "M", "model: sonnet\nthinking: high", "p");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["M"].model).toBe("sonnet");
  expect(reg["M"].thinking).toBe("high");
  expect(reg["M"].tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"]);
});

test("disabled names in subagents.json set enabled=false; enabledTypes filters them", () => {
  const cwd = tmp();
  writeAgent(join(cwd, ".hoy", "agents"), "Off", "description: d", "p");
  writeFileSync(join(cwd, ".hoy", "subagents.json"), JSON.stringify({ disabled: ["Off"] }));
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Off"].enabled).toBe(false);
  expect(enabledTypes(reg).find((t) => t.name === "Off")).toBeUndefined();
  expect(enabledTypes(reg).find((t) => t.name === "Explore")).toBeDefined();
});

test("malformed frontmatter is skipped, others still load", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".hoy", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".hoy", "agents", "Broken.md"), "---\n: : bad yaml : :\n---\nbody");
  writeAgent(join(cwd, ".hoy", "agents"), "Good", "description: ok", "p");
  const reg = loadSubagentRegistry(tmp(), cwd);
  expect(reg["Good"]).toBeDefined();
  expect(reg["Broken"]).toBeUndefined();
  expect(reg["general-purpose"]).toBeDefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents-registry.test.ts`
Expected: FAIL, module `./hoy-agents-registry` not found.

- [ ] **Step 3: Implement `hoy-agents-registry.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents-registry.test.ts`
Expected: PASS (7 tests). If `parseFrontmatter`'s import path differs, check `hoy-mcp.ts` imports and Pi's `dist/index.d.ts` (it is exported at the package root).

- [ ] **Step 5: Commit**

```bash
git add packages/sidecar/pi-src/hoy-agents-registry.ts packages/sidecar/pi-src/hoy-agents-registry.test.ts
git commit -m "HOY-234: subagent registry loader (built-ins + .md files, precedence, validation)"
```

---

### Task 2: Registry-driven `agent` tool + trust gate + dynamic prompt

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-agents.ts` (replace the hardcoded `SUBAGENT_TYPES`/`resolveSubagentType`/`Type.Union` with registry-driven behavior)
- Modify: `packages/sidecar/pi-src/hoy-system-prompt.ts` (`buildHoySystemPrompt` + `AGENT_TOOLS_PROMPT` take the enabled type list)
- Modify: `packages/sidecar/pi-src/hoy-mcp.test.ts` (the `buildHoySystemPrompt` agent-block assertions) and `packages/sidecar/pi-src/hoy-agents.test.ts` (existing consent/notify tests)

**Interfaces:**
- Consumes from Task 1: `SubagentRegistry`, `SubagentType`, `enabledTypes`.
- Produces: `createHoyAgents(registry: SubagentRegistry)` (was `createHoyAgents()`); `buildHoySystemPrompt(mcpConfigured: boolean, agentEnabled?: boolean, agentTypes?: Array<{ name: string; description?: string }>): string`.

- [ ] **Step 1: Write the failing tests**

In `hoy-system-prompt` test location (`hoy-mcp.test.ts`, the existing agent-block test), replace with:

```ts
  test("system prompt advertises enabled agent types dynamically", () => {
    expect(buildHoySystemPrompt(false, false)).not.toContain("Subagents:");
    const enabled = buildHoySystemPrompt(false, true, [
      { name: "Explore", description: "read-only" },
      { name: "Reviewer", description: "reviews diffs" },
    ]);
    expect(enabled).toContain("Subagents:");
    expect(enabled).toContain("Explore");
    expect(enabled).toContain("Reviewer");
    expect(enabled).toContain("reviews diffs");
    expect(enabled).toContain("delivered back");
  });
```

Add to `hoy-agents.test.ts` a trust-gate test (mirror its existing `ctx` double, which must expose `isProjectTrusted`):

```ts
test("execute refuses a project-scoped type when the project is untrusted", async () => {
  const registry = {
    Explore: { name: "Explore", scope: "builtin", tools: ["read"], promptMode: "replace", enabled: true },
    Proj: { name: "Proj", scope: "project", tools: ["read"], promptMode: "replace", enabled: true },
  } as any;
  const tool = mountAgentTool(registry); // helper that registers createHoyAgents(registry) and returns the tool
  const untrusted = ctx({ trusted: false }); // ctx double with isProjectTrusted: () => false, ui.select -> Allow
  await expect(tool.execute("c1", { subagentType: "Proj", task: "t" }, undefined, undefined, untrusted))
    .rejects.toThrow(/not trusted/i);
  // built-in still allowed under the same untrusted ctx
  const res = await tool.execute("c2", { subagentType: "Explore", task: "t" }, undefined, undefined, untrusted);
  expect(res.content[0].text).toContain("Spawned");
});
```

(If `hoy-agents.test.ts` lacks a `ctx`/`mount` helper, add small ones mirroring `hoy-mcp.test.ts`'s `ctx`: an object with `ui: { select: async () => "Allow", notify: () => {} }` and `isProjectTrusted: () => opts.trusted ?? true`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sidecar/pi-src && bun test hoy-mcp.test.ts hoy-agents.test.ts`
Expected: FAIL (arity of `buildHoySystemPrompt`/`createHoyAgents`, missing dynamic advertisement, no trust gate).

- [ ] **Step 3: Rewrite `AGENT_TOOLS_PROMPT` + `buildHoySystemPrompt`** (`hoy-system-prompt.ts`)

Replace the static `AGENT_TOOLS_PROMPT` (lines 93-100) and `buildHoySystemPrompt` (lines 102-110) with a builder that lists the enabled types:

```ts
// Built from the enabled registry types so the model sees exactly what it can
// spawn. HOY-233 delivery contract retained: results come back.
export function agentToolsPrompt(agentTypes: Array<{ name: string; description?: string }>): string {
  const lines = agentTypes.map((t) => `  - ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n");
  return `Subagents:
- The agent tool spawns a specialized child agent that runs in its own thread. Call agent({subagentType, task}) with a complete, self-contained task; the subagent does not see this conversation. Available types:
${lines}
- Fire-and-forget: the call returns a handle immediately and the subagent runs independently. When it finishes, its result is delivered back into this conversation as a new message, so you may keep working; you will be resumed with the subagent's result when it arrives.
- Spawning asks for user approval. A subagent cannot spawn further subagents.`;
}

export function buildHoySystemPrompt(
  mcpConfigured: boolean,
  agentEnabled = false,
  agentTypes: Array<{ name: string; description?: string }> = [],
): string {
  let prompt = HOY_SYSTEM_PROMPT;
  if (mcpConfigured) prompt += `\n\n${MCP_TOOLS_PROMPT}`;
  if (agentEnabled) prompt += `\n\n${agentToolsPrompt(agentTypes)}`;
  return prompt;
}
```

Update the invariant comment at `hoy-system-prompt.ts:17-23` to say the agent block is built dynamically from the enabled registry types.

- [ ] **Step 4: Rewrite `hoy-agents.ts` to be registry-driven**

Replace the hardcoded `SUBAGENT_TYPES`, `resolveSubagentType`, `GENERAL_TOOLS`/`EXPLORE_TOOLS`/`EXPLORE_PROMPT` (these now live in `hoy-agents-registry.ts`) and the `Type.Union` param. Keep `SPAWN_NOTIFY_PREFIX`. New file body:

```ts
// HOY-231 Phase 1 + HOY-234 Phase 3: the `agent` tool. Consent + fire-and-forget
// sentinel notify (Rust turns it into SubagentSpawned). The subagent type is now
// resolved against the loaded registry (hoy-agents-registry.ts), the param is a
// dynamic string, and project-scoped types are trust-gated here (the only place
// with ctx). See docs/plans/HOY-234-*.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRegistry } from "./hoy-agents-registry";
import { enabledTypes } from "./hoy-agents-registry";

export const SPAWN_NOTIFY_PREFIX = "@hoy/spawn-subagent:";

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

export function createHoyAgents(registry: SubagentRegistry) {
  const sessionAllowed = new Set<string>();
  const types = enabledTypes(registry);
  const agentParams = Type.Object({
    subagentType: Type.String({
      description: `One of the available subagent types: ${types.map((t) => t.name).join(", ")}.`,
    }),
    task: Type.String({ description: "The full task prompt handed to the subagent." }),
  });

  async function run(params: any, ctx: ExtensionContext) {
    const name = String(params.subagentType ?? "");
    const type = registry[name];
    if (!type || !type.enabled) {
      throw new Error(`Unknown subagent type: "${name}". Available: ${types.map((t) => t.name).join(", ")}.`);
    }
    if (type.scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error(
        `Subagent "${name}" is defined in this project's .hoy/agents, which is not trusted. Trust the project to use it.`,
      );
    }
    const task = String(params.task ?? "").trim();
    if (!task) throw new Error("agent requires a non-empty task.");

    if (!sessionAllowed.has(type.name)) {
      const snippet = task.length > 80 ? `${task.slice(0, 77)}...` : task;
      const choice = await ctx.ui.select(`Spawn ${type.name} subagent to: ${snippet}?`, [ALLOW, ALLOW_SESSION, DENY]);
      if (choice === ALLOW_SESSION) sessionAllowed.add(type.name);
      else if (choice !== ALLOW) throw new Error(`User declined to spawn ${type.name} subagent.`);
    }

    const agentId = crypto.randomUUID();
    ctx.ui.notify(`${SPAWN_NOTIFY_PREFIX}${JSON.stringify({ agentId, subagentType: type.name, task })}`, "info");
    return {
      content: [
        {
          type: "text" as const,
          text: `Spawned ${type.name} subagent (${agentId}). It runs in its own thread; its result will be delivered back into this conversation when it finishes.`,
        },
      ],
      details: { agentId },
    };
  }

  return function hoyAgents(pi: ExtensionAPI) {
    pi.registerTool({
      name: "agent",
      label: "Agent",
      description:
        "Spawn a specialized child agent to work on a task in its own thread. subagentType selects a registered agent type. Fire-and-forget: returns a handle immediately; the subagent runs independently and its result is delivered back to you when it finishes.",
      promptSnippet: "agent (spawn a specialized child agent that runs in its own thread)",
      parameters: agentParams,
      execute: async (_id, params, _signal, _onUpdate, ctx) => run(params, ctx),
    });
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sidecar/pi-src && bun test`
Expected: PASS across the sidecar suite (registry tests, the new prompt + trust-gate tests, and the existing HOY-233 delivery-wording test still green since the `delivered back` phrase remains).

- [ ] **Step 6: Commit**

```bash
git add packages/sidecar/pi-src/hoy-agents.ts packages/sidecar/pi-src/hoy-system-prompt.ts packages/sidecar/pi-src/hoy-mcp.test.ts packages/sidecar/pi-src/hoy-agents.test.ts
git commit -m "HOY-234: agent tool resolves against the registry, trust-gates project types, advertises dynamically"
```

---

### Task 3: Sidecar factory wiring + prompt composition + one-shot list mode

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-sidecar.ts`
- Test: extend `packages/sidecar/pi-src/hoy-agents-registry.test.ts` with a prompt-composition unit (an exported helper).

**Interfaces:**
- Consumes: `loadSubagentRegistry`, `enabledTypes`, `SubagentType` (Task 1); `createHoyAgents(registry)` (Task 2); `buildHoySystemPrompt(mcpConfigured, agentEnabled, agentTypes)` (Task 2).
- Produces: `effectiveChildPrompt(type: SubagentType, basePrompt: string): string` (exported from `hoy-agents-registry.ts`); the `HOY_LIST_SUBAGENTS` one-shot JSON contract.

- [ ] **Step 1: Write the failing test** (append to `hoy-agents-registry.test.ts`)

```ts
import { effectiveChildPrompt } from "./hoy-agents-registry";

test("effectiveChildPrompt: replace uses the body, append concatenates, none uses base", () => {
  const base = "BASE";
  expect(effectiveChildPrompt({ name: "a", scope: "builtin", tools: [], promptMode: "replace", body: "BODY", enabled: true }, base)).toBe("BODY");
  expect(effectiveChildPrompt({ name: "b", scope: "builtin", tools: [], promptMode: "append", body: "BODY", enabled: true }, base)).toBe("BASE\n\nBODY");
  expect(effectiveChildPrompt({ name: "c", scope: "builtin", tools: [], promptMode: "replace", enabled: true }, base)).toBe("BASE");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents-registry.test.ts`
Expected: FAIL, `effectiveChildPrompt` not exported.

- [ ] **Step 3: Add `effectiveChildPrompt`** to `hoy-agents-registry.ts`

```ts
// The child's system prompt given its type and the base Hoy prompt: replace uses
// the body verbatim, append concatenates onto the base, and no body inherits the
// base (general-purpose).
export function effectiveChildPrompt(type: SubagentType, basePrompt: string): string {
  if (!type.body) return basePrompt;
  return type.promptMode === "append" ? `${basePrompt}\n\n${type.body}` : type.body;
}
```

- [ ] **Step 4: Verify the unit passes**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `hoy-sidecar.ts`**

Replace the import at line 24 and the factory body (lines 56-96) + add the one-shot before `runRpcMode`.

Change the import:
```ts
import { createHoyAgents } from "./hoy-agents";
import { loadSubagentRegistry, enabledTypes, effectiveChildPrompt } from "./hoy-agents-registry";
```

Replace the factory (56-96) with:
```ts
const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const mcpConfig = loadMcpConfig(agentDir, cwd);
  const registry = loadSubagentRegistry(agentDir, cwd);
  const childType = subagentType ? registry[subagentType] : null;
  const tools = childType ? childType.tools : HOY_TOOLS;
  const advertised = enabledTypes(registry).map((t) => ({ name: t.name, description: t.description }));

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      noContextFiles: false,
      systemPromptOverride: () => {
        const base = buildHoySystemPrompt(mcpConfig.servers.length > 0, !childType, advertised);
        return childType ? effectiveChildPrompt(childType, buildHoySystemPrompt(mcpConfig.servers.length > 0, false)) : base;
      },
      extensionFactories: childType
        ? [createHoyPermissions(initialMode), createHoyMcp(mcpConfig)]
        : [createHoyPermissions(initialMode), createHoyMcp(mcpConfig), createHoyAgents(registry)],
    },
  });
  const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools });
  return { ...result, services, diagnostics: services.diagnostics };
};
```

Add the one-shot mode near the OAuth branch (after line 54, before `const factory`):
```ts
// One-shot registry dump for the settings UI (Rust spawns us with this env,
// captures stdout, and exits us). Prints the resolved registry as JSON. Uses the
// same loader as runtime, so the UI never drifts from what actually runs.
if (process.env.HOY_LIST_SUBAGENTS) {
  const reg = loadSubagentRegistry(agentDir, process.cwd());
  const defs = Object.values(reg).map((t) => ({
    name: t.name,
    scope: t.scope,
    description: t.description ?? null,
    tools: t.tools,
    promptMode: t.promptMode,
    model: t.model ?? null,
    thinking: t.thinking ?? null,
    source: t.source ?? null,
    enabled: t.enabled,
  }));
  process.stdout.write(JSON.stringify(defs));
  process.exit(0);
}
```

- [ ] **Step 6: Run the full sidecar suite + build**

Run: `cd packages/sidecar/pi-src && bun test` (all green), then `cd packages/sidecar && ./build.sh` (compiles).
Expected: tests pass; the binary builds. Manually smoke the one-shot:
`HOY_LIST_SUBAGENTS=1 PI_CODING_AGENT_DIR=$(mktemp -d) ./hoy-pi-x86_64-unknown-linux-gnu` should print a JSON array containing `general-purpose` and `Explore`.

- [ ] **Step 7: Commit**

```bash
git add packages/sidecar/pi-src/hoy-sidecar.ts packages/sidecar/pi-src/hoy-agents-registry.ts packages/sidecar/pi-src/hoy-agents-registry.test.ts
git commit -m "HOY-234: sidecar factory uses the registry + prompt composition + one-shot list mode"
```

---

### Task 4: Rust `subagents_config.rs` (enable/disable state)

**Files:**
- Create: `apps/desktop/src-tauri/src/subagents_config.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod subagents_config;`)

**Interfaces:**
- Produces: `pub enum SubagentScope { Global, Project }` (serde lowercase, mirrors `McpScope`); `pub fn set_enabled(scope: SubagentScope, project: Option<&str>, name: &str, enabled: bool) -> Result<(), String>`.

This module clones the atomic-write + tolerant-read scaffold of `mcp_config.rs` verbatim (I have that file's exact body), storing a per-scope disabled list in `subagents.json`: `{ "disabled": ["Name", ...] }`. `set_enabled(false)` inserts the name; `set_enabled(true)` removes it. Paths: global `agent_dir()?.join("subagents.json")`, project `PathBuf::from(project).join(".hoy").join("subagents.json")`.

- [ ] **Step 1: Write the failing test** (in `subagents_config.rs`, `#[cfg(test)]`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disable_then_enable_round_trips_and_preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("hoy-sub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("subagents.json");
        // Seed an unknown top-level key to prove read-modify-write preserves it.
        std::fs::write(&path, serde_json::to_vec(&json!({ "note": "keep", "disabled": [] })).unwrap()).unwrap();

        set_disabled_at(&path, "Reviewer", true).unwrap();
        let after: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["note"], "keep");
        assert_eq!(after["disabled"], json!(["Reviewer"]));

        set_disabled_at(&path, "Reviewer", false).unwrap();
        let after2: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after2["disabled"], json!([]));
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test subagents_config`
Expected: FAIL (module/function absent). Add `mod subagents_config;` to `lib.rs` first if needed for compilation.

- [ ] **Step 3: Implement `subagents_config.rs`**

Clone `mcp_config.rs`'s `read_config_at` / `write_config_atomic_at` verbatim (same atomic tmp+fsync+rename, 0700/0600, malformed-tolerant read; rename the tmp file to `subagents.json.tmp-<pid>`). Then:

```rust
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use crate::pi_config::agent_dir;

const PROJECT_CONFIG_DIR: &str = ".hoy";
static SUBAGENTS_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentScope {
    Global,
    Project,
}

fn global_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("subagents.json"))
}
fn project_path(project: &str) -> Result<PathBuf, String> {
    if project.trim().is_empty() {
        return Err("project path is required for project scope".to_string());
    }
    Ok(PathBuf::from(project).join(PROJECT_CONFIG_DIR).join("subagents.json"))
}
fn path_for(scope: SubagentScope, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        SubagentScope::Global => global_path(),
        SubagentScope::Project => project_path(project.unwrap_or("")),
    }
}

// read_config_at + write_config_atomic_at cloned from mcp_config.rs (verbatim,
// only the tmp filename literal changes to "subagents.json.tmp-{pid}").

fn disabled_vec(config: &Map<String, Value>) -> Vec<String> {
    match config.get("disabled") {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn set_disabled_at(path: &Path, name: &str, disabled: bool) -> Result<(), String> {
    let _guard = SUBAGENTS_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut config = read_config_at(path);
    let mut list = disabled_vec(&config);
    let present = list.iter().any(|n| n == name);
    if disabled && !present {
        list.push(name.to_string());
    } else if !disabled && present {
        list.retain(|n| n != name);
    } else {
        return Ok(());
    }
    config.insert("disabled".to_string(), Value::Array(list.into_iter().map(Value::String).collect()));
    write_config_atomic_at(path, &config)
}

pub fn set_enabled(scope: SubagentScope, project: Option<&str>, name: &str, enabled: bool) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("subagent name is required".to_string());
    }
    set_disabled_at(&path_for(scope, project)?, name.trim(), !enabled)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test subagents_config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/subagents_config.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "HOY-234: subagents.json enable/disable state (Rust, serde_json)"
```

---

### Task 5: Rust commands (`list_subagents` one-shot + `set_subagent_enabled`)

**Files:**
- Modify: `apps/desktop/src-tauri/src/sidecar.rs` (a `SidecarManager::list_subagents(cwd)` method that spawns the one-shot and captures stdout)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (two `#[tauri::command]` fns)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register both in `generate_handler!`)

**Interfaces:**
- Consumes: `subagents_config::{SubagentScope, set_enabled}` (Task 4); `SidecarManager` fields `bin`, `payload`, `agent_dir` (exist).
- Produces: `#[tauri::command] pub fn list_subagents(cwd: String, manager: State<SidecarManager>) -> Result<Value, String>`; `#[tauri::command] pub async fn set_subagent_enabled(scope: SubagentScope, name: String, enabled: bool, project_path: Option<String>, manager: State<SidecarManager>) -> Result<(), String>`.

- [ ] **Step 1: Add the `SidecarManager::list_subagents` method** (`sidecar.rs`)

```rust
// HOY-234: dump the resolved subagent registry via a one-shot sidecar run. Mirrors
// the OAuth one-shot (a spawn of self.bin with a mode env), but non-interactive:
// spawn with HOY_LIST_SUBAGENTS=1, capture stdout JSON, exit. cwd selects the
// project's .hoy/agents.
pub fn list_subagents(&self, cwd: &Path) -> Result<serde_json::Value, String> {
    if !self.bin.exists() {
        return Err(format!("sidecar binary not found at {}. Run sidecar/build.sh.", self.bin.display()));
    }
    let out = std::process::Command::new(&self.bin)
        .env("PI_PACKAGE_DIR", &self.payload)
        .env("PI_CODING_AGENT_DIR", &self.agent_dir)
        .env("HOY_LIST_SUBAGENTS", "1")
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn sidecar for list_subagents: {e}"))?;
    if !out.status.success() {
        return Err(format!("list_subagents exited {}: {}", out.status, String::from_utf8_lossy(&out.stderr)));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("parse list_subagents output: {e}"))
}
```

- [ ] **Step 2: Add the two commands** (`commands.rs`, near the MCP block ~line 228)

```rust
use crate::subagents_config::{self, SubagentScope};

#[tauri::command]
pub fn list_subagents(cwd: String, manager: State<'_, SidecarManager>) -> Result<serde_json::Value, String> {
    let path = if cwd.trim().is_empty() { std::env::temp_dir() } else { PathBuf::from(cwd) };
    manager.list_subagents(&path)
}

#[tauri::command]
pub async fn set_subagent_enabled(
    scope: SubagentScope,
    name: String,
    enabled: bool,
    project_path: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<(), String> {
    subagents_config::set_enabled(scope, project_path.as_deref(), &name, enabled)?;
    respawn_idle_sessions(&manager).await;
    Ok(())
}
```

- [ ] **Step 3: Register both** in `lib.rs` `generate_handler!` (after the MCP entries, around line 87):

```rust
            commands::list_mcp_servers,
            commands::save_mcp_server,
            commands::remove_mcp_server,
            commands::list_subagents,
            commands::set_subagent_enabled,
```

- [ ] **Step 4: Build + verify**

Run: `cd apps/desktop/src-tauri && cargo build && cargo test`
Expected: compiles; tests pass. (No new unit test here; the one-shot is exercised at live-verify. The method's error paths are simple.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/sidecar.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "HOY-234: list_subagents (one-shot) + set_subagent_enabled commands"
```

---

### Task 6: Renderer ipc + types + store (registry cache + child model application)

**Files:**
- Modify: `apps/desktop/src/lib/ipc.ts` (add `listSubagents`, `setSubagentEnabled`)
- Modify: `apps/desktop/src/lib/types.ts` (add `SubagentDef`, `SubagentScope`)
- Modify: `apps/desktop/src/state/store.ts` (cache the registry; `setSubagentEnabled` wrapper; apply model/thinking in `spawnChildThread`)

**Interfaces:**
- Consumes: existing `invoke`, `createSession`, `applyThreadModel`, `applyThreadPermissionMode`, `findThread`, `patchThread`, `streamPromptOnThread`.
- Produces: `listSubagents(cwd, projectPath?)`, `setSubagentEnabled(scope, name, enabled, projectPath?)`; `SubagentDef`; store state `subagents: SubagentDef[]` + action `refreshSubagents` + `setSubagentEnabled`.

- [ ] **Step 1: Add types** (`types.ts`, near the MCP types ~line 412)

```ts
export type SubagentScope = "builtin" | "global" | "project";

export interface SubagentDef {
  name: string;
  scope: SubagentScope;
  description: string | null;
  tools: string[];
  promptMode: "replace" | "append";
  model: string | null;
  thinking: string | null;
  source: string | null;
  enabled: boolean;
}
```

- [ ] **Step 2: Add ipc wrappers** (`ipc.ts`, near the MCP wrappers ~line 109)

```ts
export function listSubagents(cwd: string): Promise<SubagentDef[]> {
  return invoke<SubagentDef[]>("list_subagents", { cwd });
}
export function setSubagentEnabled(
  scope: SubagentScope,
  name: string,
  enabled: boolean,
  projectPath?: string | null,
): Promise<void> {
  return invoke<void>("set_subagent_enabled", { scope, name, enabled, projectPath: projectPath ?? null });
}
```
(Import `SubagentDef`, `SubagentScope` from `./types`.)

- [ ] **Step 3: Store - cache + wrapper.** Add state `subagents: SubagentDef[]` (default `[]`), and actions:

```ts
refreshSubagents: async (cwd) => {
  try { set({ subagents: await listSubagents(cwd) }); } catch { /* leave cache */ }
},
setSubagentEnabled: async (scope, name, enabled, projectPath) => {
  await ipcSetSubagentEnabled(scope, name, enabled, projectPath ?? null);
  modelApplied.clear();
  permissionModeApplied.clear();
},
```
(Alias imports `listSubagents`, `setSubagentEnabled as ipcSetSubagentEnabled`. Call `refreshSubagents(project.path)` where the store loads a project / opens the panel; the panel also calls it on mount.)

- [ ] **Step 4: Apply model/thinking in `spawnChildThread`.** Replace the child construction + spawn (store.ts:774-820) so it resolves the type from the cache and applies model via the proven path:

```ts
spawnChildThread: async (parentThreadId, payload) => {
  const found = findThread(get().projects, parentThreadId);
  if (!found) return;
  const { project, thread: parent } = found;
  const childId = newId("t");
  const def = get().subagents.find((d) => d.name === payload.subagentType);
  // A type with no model inherits the parent's (closes HOY-237); thinking likewise.
  const childModel = def?.model
    ? resolveModelRef(get(), def.model) ?? parent.model ?? null
    : parent.model ?? null;
  const childThinking = (def?.thinking as ThinkingLevel | undefined) ?? parent.thinkingLevel ?? null;
  const shortTask = payload.task.length > 40 ? `${payload.task.slice(0, 40)}...` : payload.task;
  const child: Thread = {
    id: childId,
    title: `${payload.subagentType}: ${shortTask}`,
    updatedAt: Date.now(),
    sessionId: null,
    parentThreadId,
    spawnedBy: { type: payload.subagentType, agentId: payload.agentId },
    ...(childModel ? { model: childModel } : {}),
    ...(childThinking ? { thinkingLevel: childThinking } : {}),
  };
  set((s) => ({
    projects: s.projects.map((p) => (p.id === project.id ? { ...p, threads: [...p.threads, child] } : p)),
    turns: { ...s.turns, [childId]: [ { role: "user", text: payload.task }, { role: "assistant", blocks: [], streaming: true } ] },
    streaming: { ...s.streaming, [childId]: true },
  }));
  try {
    const cwd = project.path ?? "";
    const sessionId = await createSession(cwd, null, payload.subagentType, parent.permissionMode ?? null);
    set((s) => ({ projects: patchThread(s.projects, childId, (t) => ({ ...t, sessionId })) }));
    await applyThreadModel(childId, sessionId);
    await applyThreadPermissionMode(childId, sessionId);
    await streamPromptOnThread(childId, sessionId, payload.task);
  } catch (e) {
    set((s) => ({
      streaming: { ...s.streaming, [childId]: false },
      threadErrors: { ...s.threadErrors, [childId]: String(e instanceof Error ? e.message : e) },
    }));
  }
},
```

Add a small `resolveModelRef(state, fuzzy): ModelRef | null` helper: match `fuzzy` against `state.models` (the loaded model list) by exact `id`, else by case-insensitive substring on `id`/`name`, returning `{ provider, id }` or null. If your store's model list field differs, adapt the lookup; the fallback to `parent.model` covers an unresolved name.

- [ ] **Step 5: Typecheck + smoke tests**

Run: `cd apps/desktop && bun run check:ts` (clean) and `bun test src/state/delivery.test.ts` (still 7/7, unaffected).
Expected: no type errors; the `spawnChildThread` change compiles; `applyThreadModel`/`applyThreadPermissionMode` are the same module-level helpers `submitPrompt` uses.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/ipc.ts apps/desktop/src/lib/types.ts apps/desktop/src/state/store.ts
git commit -m "HOY-234: renderer subagent registry cache + child model/thinking application"
```

---

### Task 7: Settings panel (`SubagentsPanel.tsx`)

**Files:**
- Create: `apps/desktop/src/components/settings/SubagentsPanel.tsx`
- Modify: `apps/desktop/src/components/settings/categories.ts` (add the category)
- Modify: `apps/desktop/src/components/settings/panels.tsx` (import + case)

**Interfaces:**
- Consumes: `listSubagents` (ipc), store `subagents`/`refreshSubagents`/`setSubagentEnabled`, `SubagentDef` type, `PanelHeader`/`Section`/`StatusDot`, `Switch`, `Badge`, `Button`, `openPath` from `@tauri-apps/plugin-opener`.

- [ ] **Step 1: Register the category** (`categories.ts`)

Add `"subagents"` to the `CategoryId` union; import `Bot` from `lucide-react`; add to `CATEGORIES` in group 1: `{ id: "subagents", label: "Subagents", icon: Bot, group: 1 }`.

- [ ] **Step 2: Register the panel** (`panels.tsx`)

Add `import { SubagentsPanel } from "./SubagentsPanel";` (near line 43) and `case "subagents": return <SubagentsPanel />;` in the `SettingsPanel` switch (near line 772).

- [ ] **Step 3: Write `SubagentsPanel.tsx`** (clone `McpPanel.tsx`'s load/section/toggle shape)

Structure (complete component):

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, FileText } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { listSubagents } from "@/lib/ipc";
import type { SubagentDef, SubagentScope } from "@/lib/types";
import { useSessionStore } from "@/state/store";
import { PanelHeader, StatusDot } from "./panels";

function AgentRow({ def, onToggle, busy }: { def: SubagentDef; onToggle?: (next: boolean) => void; busy?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <StatusDot on={def.enabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{def.name}</span>
          <Badge variant="outline" className="text-[10px]">{def.scope}</Badge>
          {def.model && <Badge variant="outline" className="text-[10px]">{def.model}</Badge>}
        </div>
        {def.description && <p className="text-xs text-muted-foreground">{def.description}</p>}
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{def.tools.join(", ")}</p>
      </div>
      {def.source && (
        <Button variant="ghost" size="icon" title="Open definition file" onClick={() => void openPath(def.source!)}>
          <FileText className="size-4" />
        </Button>
      )}
      {def.scope === "builtin" ? (
        <span className="text-xs text-muted-foreground">built-in</span>
      ) : (
        <Switch checked={def.enabled} disabled={busy} onCheckedChange={(v) => onToggle?.(v)} aria-label={`Enable ${def.name}`} />
      )}
    </div>
  );
}

export function SubagentsPanel() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const setSubagentEnabled = useSessionStore((s) => s.setSubagentEnabled);
  const projectPath = useMemo(() => projects.find((p) => p.id === activeProjectId)?.path ?? null, [projects, activeProjectId]);

  const [defs, setDefs] = useState<SubagentDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setError(null); setDefs(await listSubagents(projectPath ?? "")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [projectPath]);
  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = (def: SubagentDef, next: boolean) => {
    setBusy(true);
    void (async () => {
      try {
        const scope = def.scope as SubagentScope; // built-in rows have no Switch
        await setSubagentEnabled(scope, def.name, next, projectPath);
        await refresh();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  };

  const byScope = (scope: SubagentScope) => (defs ?? []).filter((d) => d.scope === scope);

  return (
    <div className="space-y-6">
      <PanelHeader title="Subagents" description="Specialized agent types the model can spawn. Author them as .hoy/agents/*.md; built-ins are always available." />
      {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {(["builtin", "global", "project"] as SubagentScope[]).map((scope) => {
        const rows = byScope(scope);
        if (scope === "project" && !projectPath) return null;
        return (
          <div key={scope} className="space-y-3">
            <h2 className="text-sm font-semibold capitalize">{scope === "builtin" ? "Built-in" : scope === "global" ? "Global" : "This project"}</h2>
            <div className="divide-y divide-border border border-border">
              {rows.length ? rows.map((d) => <AgentRow key={d.name} def={d} busy={busy} onToggle={(v) => toggle(d, v)} />)
                : <p className="px-3 py-2 text-xs text-muted-foreground">No agents in this scope.</p>}
            </div>
          </div>
        );
      })}
      {!defs && !error && <p className="text-xs text-muted-foreground">Loading agents...</p>}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && bun run check:ts`
Expected: clean. If `Badge` variants differ, check `components/ui/badge.tsx`; if `openPath` is not exported by the installed `@tauri-apps/plugin-opener`, fall back to omitting the open-file button (leave a follow-up note).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/settings/SubagentsPanel.tsx apps/desktop/src/components/settings/categories.ts apps/desktop/src/components/settings/panels.tsx
git commit -m "HOY-234: subagents settings panel"
```

---

### Task 8: Build, integrate, live-verify

**Files:** none new; this task rebuilds and verifies end to end.

- [ ] **Step 1: Rebuild the sidecar** (HOY-200)

Run: `cd packages/sidecar && ./build.sh`
Expected: binary + payload rebuilt.

- [ ] **Step 2: Full gates**

Run: `cd apps/desktop && bun run check:ts` and `cd packages/sidecar/pi-src && bun test` and `cd apps/desktop/src-tauri && cargo test`.
Expected: all green (renderer `tests/` has 21 pre-existing unrelated failures from a `saveMcpServer` test-mock issue, tracked in HOY-241; ignore those, they are not part of this change).

- [ ] **Step 3: Live-verify via the Tauri bridge** (`bun run tauri:dev`)

1. Open Settings -> Subagents; confirm Built-in shows `general-purpose` + `Explore` with their tools.
2. Author `<project>/.hoy/agents/Reviewer.md`:
   ```
   ---
   description: Reviews a diff for correctness
   tools: [read, grep, find, ls]
   prompt_mode: replace
   ---
   You are a code reviewer. Read the changed files and report correctness issues with file:line references. You are read-only.
   ```
   Refresh the panel; `Reviewer` appears under This project with its tools.
3. In a thread, prompt Hoy to spawn a `Reviewer` subagent for a small task; approve consent; confirm the child runs with only read-only tools and the Reviewer prompt, and its result delivers back to the parent (Phase 2).
4. Disable `Reviewer` in settings; confirm (after the sidecar respawns) the parent no longer lists/accepts it.
5. Author an `append`-mode agent and confirm its child prompt includes the base Hoy prompt plus the body (spot-check behavior, e.g. it still follows Hoy tool guidelines).

- [ ] **Step 4: Commit any fixups + final**

```bash
git commit -am "HOY-234: live-verify fixups" # only if needed
```

## Self-Review

**Spec coverage:**
- `.hoy/agents/*.md` discovery + precedence + built-ins -> Task 1.
- Frontmatter (description/tools/prompt_mode/model/thinking) -> Task 1 parse, Task 2 advertise, Task 3 prompt compose, Task 6 model apply.
- Dynamic `subagentType` + advertisement -> Task 2.
- project_trust gate -> Task 2 (`execute()` scope+trust).
- Depth cap (agent stripped) -> Task 1 `validateTools`.
- `subagents.json` enable/disable + settings UI -> Tasks 4-7.
- One-shot list authority -> Task 3 (sidecar) + Task 5 (Rust spawn/capture).
- Model inheritance (HOY-237) -> Task 6.

**Placeholder scan:** every code step carries complete code; the two clone-tasks (4 boilerplate, 7 panel) give full new code and name the exact verbatim template (`mcp_config.rs` read/write; `McpPanel.tsx` load/section/toggle). No "TBD"/"add error handling"/"similar to".

**Type consistency:** `SubagentType` (sidecar) fields match across Tasks 1-3; `SubagentDef` (renderer/one-shot JSON) fields match between Task 3's one-shot output, Task 5's `Value` passthrough, and Task 6's type. `set_enabled(scope, project, name, enabled)` (Task 4) matches the `set_subagent_enabled` command call (Task 5) and the `setSubagentEnabled` ipc/store wrapper (Task 6). `loadSubagentRegistry(agentDir, cwd)` signature is identical in Tasks 1/3.

## Notes for the executor

- Rust adds NO dependency; `subagents.json` is JSON via `serde_json`. If you find yourself reaching for `serde_yaml`, stop: frontmatter is parsed only in the sidecar.
- The one-shot list mode reuses the runtime loader, so the settings UI shows exactly what runs. Do not add a second parser in Rust.
- `applyThreadModel` early-returns per sessionId (guarded by `modelApplied`), so calling it in `spawnChildThread` is safe and idempotent; it is the same helper `submitPrompt` uses at store.ts:1110.
- Keep `SPAWN_NOTIFY_PREFIX` byte-identical in `hoy-agents.ts` and `sidecar.rs` (unchanged from Phase 1).
