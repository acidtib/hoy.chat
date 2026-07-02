// HOY-231 Phase 1: subagent support. The `agent` tool takes consent then fires a
// fire-and-forget sentinel notify; Rust turns it into AgentEvent::SubagentSpawned
// and the renderer spawns the child as its own thread. Fire-and-forget: the call
// returns a handle; the subagent's result is delivered back to the parent when it
// finishes (HOY-233). See docs/plans/HOY-231-*.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Byte-identical to SPAWN_NOTIFY_PREFIX in sidecar.rs. A notify whose message
// starts with this is a spawn request Rust consumes, never a user-facing notice.
export const SPAWN_NOTIFY_PREFIX = "@hoy/spawn-subagent:";

export interface SubagentType {
  name: string;
  tools: string[];
  // undefined = inherit the base Hoy prompt (buildHoySystemPrompt).
  systemPromptOverride?: string;
}

// Depth cap: neither built-in includes "agent", so a child cannot spawn.
const GENERAL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp"];
const EXPLORE_TOOLS = ["read", "grep", "find", "ls"];

const EXPLORE_PROMPT = `You are Hoy running as an Explore subagent: a read-only investigator spawned by another agent to answer a focused question about this codebase.

Available tools: read, grep, find, ls. You have no write, edit, or bash access; do not ask for them.

Work: locate the relevant files, read what matters, and report concise findings with file paths and line numbers (for example src/main.rs:42). Do not speculate beyond what you read. Be direct; your response renders as markdown. Do not use emojis or em-dashes.`;

export const SUBAGENT_TYPES: Record<string, SubagentType> = {
  "general-purpose": { name: "general-purpose", tools: GENERAL_TOOLS },
  Explore: { name: "Explore", tools: EXPLORE_TOOLS, systemPromptOverride: EXPLORE_PROMPT },
};

export function resolveSubagentType(name: string): SubagentType {
  const t = SUBAGENT_TYPES[name];
  if (!t) {
    throw new Error(`Unknown subagent type: "${name}". Available: ${Object.keys(SUBAGENT_TYPES).join(", ")}.`);
  }
  return t;
}

const agentParams = Type.Object({
  subagentType: Type.Union([Type.Literal("general-purpose"), Type.Literal("Explore")], {
    description: "general-purpose (full tools) or Explore (read-only: read/grep/find/ls).",
  }),
  task: Type.String({ description: "The full task prompt handed to the subagent." }),
});

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

export function createHoyAgents() {
  const sessionAllowed = new Set<string>(); // subagent type granted for the session

  async function run(params: any, ctx: ExtensionContext) {
    const type = resolveSubagentType(params.subagentType);
    const task = String(params.task ?? "").trim();
    if (!task) throw new Error("agent requires a non-empty task.");

    if (!sessionAllowed.has(type.name)) {
      const snippet = task.length > 80 ? `${task.slice(0, 77)}...` : task;
      const choice = await ctx.ui.select(`Spawn ${type.name} subagent to: ${snippet}?`, [
        ALLOW,
        ALLOW_SESSION,
        DENY,
      ]);
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
        "Spawn a specialized child agent to work on a task in its own thread. subagentType: general-purpose (full tools) or Explore (read-only). Fire-and-forget: returns a handle; the subagent runs independently.",
      promptSnippet: "agent (spawn a child agent, general-purpose or Explore, that runs in its own thread)",
      parameters: agentParams,
      execute: async (_id, params, _signal, _onUpdate, ctx) => run(params, ctx),
    });
  };
}
