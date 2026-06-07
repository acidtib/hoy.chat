// Hoy's permission gate, registered in-process via extensionFactories (HOY-186).
// Implements the four thread modes over pi's blockable tool_call event and the
// extension UI sub-protocol: "ask" raises ctx.ui.select, which in RPC mode
// emits extension_ui_request on stdout and blocks the agent until Rust writes
// the matching extension_ui_response (rpc.md, Extension UI Protocol).
//
// Mode lives in closure state. Initial value comes from HOY_PERMISSION_MODE
// (set by Rust at spawn so respawns restore it); changes arrive as the
// /hoy_mode extension command, which the RPC prompt command executes
// immediately even mid-stream. A resource-loader reload() re-runs this factory
// and resets mode to the env value; Rust keeps the env in sync on every mode
// change so that reset is harmless.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTONOMOUS_MODE_PROMPT, PLAN_MODE_PROMPT } from "./hoy-system-prompt";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "autonomous";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "autonomous"];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as string[]).includes(value);
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);

export type GateDecision = "allow" | "ask" | "block";

// The policy table from HOY-186. Read-only tools never gate; custom tools are
// treated like bash (and fail safe to block in plan mode).
export function decide(mode: PermissionMode, toolName: string): GateDecision {
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "autonomous") return "allow";
  if (mode === "plan") {
    if (toolName === "write" || toolName === "mcp" || toolName === "bash") return "allow";
    return "block";
  }
  if (MUTATING_TOOLS.has(toolName)) return mode === "acceptEdits" ? "allow" : "ask";
  return "ask"; // bash and unknown/custom tools in default and acceptEdits
}

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

// One-line summary of what the tool wants to do, for the approval card title.
function describeToolCall(toolName: string, input: any): string {
  let detail = "";
  if (toolName === "bash" && typeof input?.command === "string") {
    detail = input.command;
  } else if (typeof input?.path === "string") {
    detail = input.path;
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
  return detail ? `${toolName}: ${detail}` : toolName;
}

function blockReason(mode: PermissionMode, toolName: string): string {
  if (mode === "plan") {
    return `Plan mode is active: ${toolName} is disabled. Continue exploring with read, grep, find, and ls, and present a plan as your reply.`;
  }
  return `The ${toolName} call was blocked by the active permission mode.`;
}

const DENY_REASON =
  "The user declined this tool call. Do not retry it unchanged; adjust your approach or ask the user how to proceed.";

export function createHoyPermissions(initialMode: PermissionMode) {
  return function hoyPermissions(pi: ExtensionAPI) {
    let mode: PermissionMode = initialMode;
    // "Allow for this session" grants, keyed by tool name. Cleared on respawn
    // with the rest of the closure.
    const sessionAllowed = new Set<string>();

    pi.registerCommand("hoy_mode", {
      description: "Set the Hoy permission mode (default | acceptEdits | plan | autonomous)",
      handler: async (args, ctx) => {
        const next = args.trim();
        if (!isPermissionMode(next)) {
          ctx.ui.notify(`hoy_mode: unknown mode "${next}"`, "error");
          return;
        }
        mode = next;
        // Observable confirmation for the client (and the spike test); Rust
        // drops notify requests rather than rendering them.
        ctx.ui.notify(`permission mode: ${mode}`, "info");
      },
    });

    pi.on("before_agent_start", async (event) => {
      if (mode === "plan") {
        return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
      }
      if (mode === "autonomous") {
        return { systemPrompt: `${event.systemPrompt}\n\n${AUTONOMOUS_MODE_PROMPT}` };
      }
      return undefined;
    });

    pi.on("tool_call", async (event, ctx) => {
      const decision = decide(mode, event.toolName);
      if (decision === "allow") return undefined;
      if (decision === "block") {
        return { block: true, reason: blockReason(mode, event.toolName) };
      }
      if (sessionAllowed.has(event.toolName)) return undefined;

      const choice = await ctx.ui.select(describeToolCall(event.toolName, event.input), [
        ALLOW,
        ALLOW_SESSION,
        DENY,
      ]);
      if (choice === ALLOW) return undefined;
      if (choice === ALLOW_SESSION) {
        sessionAllowed.add(event.toolName);
        return undefined;
      }
      // Deny, or undefined when the dialog was cancelled (teardown/abort).
      return { block: true, reason: DENY_REASON };
    });
  };
}
