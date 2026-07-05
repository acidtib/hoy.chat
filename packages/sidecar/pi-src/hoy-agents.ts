// HOY-231 Phase 1 + HOY-234 Phase 3 + HOY-300: the `agent` tool. Consent gate,
// then a BLOCKING sentinel round-trip (ctx.ui.input) that Rust turns into a
// synchronous child spawn/run/answer (see docs/plans/HOY-300-*). The subagent
// type is resolved against the loaded registry (hoy-agents-registry.ts), the
// param is a dynamic string, and project-scoped types are trust-gated here
// (the only place with ctx). See docs/plans/HOY-234-*.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRegistry } from "./hoy-agents-registry";
import { enabledTypes } from "./hoy-agents-registry";

export const SPAWN_SYNC_PREFIX = "@hoy/spawn-subagent-sync:";

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

// `requireApproval` (HOY-248) mirrors the renderer pref requireSubagentApproval,
// relayed via HOY_REQUIRE_SUBAGENT_APPROVAL. Off by default: a spawn proceeds
// without a consent prompt. On restores the per-type Allow / Allow-for-session /
// Deny gate.
export function createHoyAgents(registry: SubagentRegistry, requireApproval: boolean) {
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

    if (requireApproval && !sessionAllowed.has(type.name)) {
      const snippet = task.length > 80 ? `${task.slice(0, 77)}...` : task;
      const choice = await ctx.ui.select(`Spawn ${type.name} subagent to: ${snippet}?`, [ALLOW, ALLOW_SESSION, DENY]);
      if (choice === ALLOW_SESSION) sessionAllowed.add(type.name);
      else if (choice !== ALLOW) throw new Error(`User declined to spawn ${type.name} subagent.`);
    }

    const agentId = crypto.randomUUID();
    const payload = JSON.stringify({ agentId, subagentType: type.name, task });
    // Blocking round-trip (HOY-300): the renderer spawns the child, runs it to
    // completion, and answers this request with the child's result. No Pi-side
    // timeout, so a long child is safe. Cancelled (abort/deny) -> undefined.
    const result = await ctx.ui.input(`${SPAWN_SYNC_PREFIX}${payload}`);
    return {
      content: [
        {
          type: "text" as const,
          text:
            result && result.trim().length > 0
              ? result
              : `The ${type.name} subagent was stopped before returning a result.`,
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
        "Spawn a specialized child agent to work on a task in its own thread. subagentType selects a registered agent type. Blocks until the child finishes and returns its result to you.",
      promptSnippet: "agent (spawn a specialized child agent that runs in its own thread)",
      parameters: agentParams,
      execute: async (_id, params, _signal, _onUpdate, ctx) => run(params, ctx),
    });
  };
}
