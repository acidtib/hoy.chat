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

import { isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTONOMOUS_MODE_PROMPT, PLAN_MODE_PROMPT } from "./hoy-system-prompt";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "autonomous";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "autonomous"];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as string[]).includes(value);
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);

// Project-relative directory where plan mode may write and edit plan files
// (HOY-213). Consistent with the other .hoy/ project state (agents, mcp.json);
// keeps agent working plans out of the team's committed docs/plans/ docs.
export const PLAN_DIR = ".hoy/plans";

// True when `path` resolves to a file strictly inside <cwd>/.hoy/plans. Resolves
// relative paths against cwd and rejects any traversal out of the plan dir, so a
// path like ../../etc/x or .hoy/plans/../../secret cannot pass.
export function isPlanFilePath(path: string | undefined, cwd: string | undefined): boolean {
  if (!path || !cwd) return false;
  const abs = isAbsolute(path) ? path : join(cwd, path);
  const planRoot = join(cwd, PLAN_DIR);
  const rel = relative(planRoot, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type GateDecision = "allow" | "ask" | "block";

// The policy table from HOY-186. Read-only tools never gate; custom tools are
// treated like bash (and fail safe to block in plan mode). `opts.path`/`opts.cwd`
// scope the plan-mode file gate (HOY-213): write and edit run frictionlessly for
// plan files under .hoy/plans, and elsewhere they ask for approval rather than
// hard-block, so a user who asks for the plan saved somewhere else can approve
// that write while the default location stays prompt-free.
export function decide(
  mode: PermissionMode,
  toolName: string,
  opts?: { path?: string; cwd?: string },
): GateDecision {
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "autonomous") return "allow";
  if (mode === "plan") {
    // agent (HOY-213): plan mode may fan out subagents to parallelize read-only
    // exploration and delegate deep planning to the Plan architect. Spawned
    // children inherit plan mode, so they stay non-mutating by construction.
    if (toolName === "mcp" || toolName === "bash" || toolName === "agent") return "allow";
    // write/edit (HOY-213): a plan file under .hoy/plans is allowed outright so
    // the architect can author and refine it; anywhere else asks for approval,
    // which is how a user-requested alternate plan location gets in.
    if (toolName === "write" || toolName === "edit") {
      return isPlanFilePath(opts?.path, opts?.cwd) ? "allow" : "ask";
    }
    return "block";
  }
  if (toolName === "agent") return "allow"; // consent lives in the agent tool (names type + task)
  if (MUTATING_TOOLS.has(toolName)) return mode === "acceptEdits" ? "allow" : "ask";
  return "ask"; // bash and unknown/custom tools in default and acceptEdits
}

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

// Summary of what the tool wants to do, for the approval card title.
// For edit and write tools, also embeds tool call metadata as a JSON prefix
// (HOY_TOOL_DATA:{...}\n) so the frontend can render a pending tool block
// with a diff in the conversation while the approval card waits (HOY-199).
function describeToolCall(toolName: string, toolCallId: string, input: any): string {
  const label = describeToolLabel(toolName, input);
  if (toolName === "edit" && typeof input?.path === "string" && Array.isArray(input?.edits)) {
    return toolDataPrefix(toolName, toolCallId, input, label);
  }
  if (toolName === "write" && typeof input?.path === "string" && typeof input?.content === "string") {
    return toolDataPrefix(toolName, toolCallId, input, label);
  }
  return label;
}

// Readable one-line label for the approval card title.
function describeToolLabel(toolName: string, input: any): string {
  if (toolName === "bash" && typeof input?.command === "string") {
    let detail = input.command.replace(/\s+/g, " ").trim();
    if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
    return `${toolName}: ${detail}`;
  }
  let detail = "";
  if (typeof input?.path === "string") detail = input.path;
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
  return detail ? `${toolName}: ${detail}` : toolName;
}

const MAX_TOOL_DATA_BYTES = 5000;

function toolDataPrefix(toolName: string, toolCallId: string, input: any, label: string): string {
  const data = JSON.stringify({ toolName, toolCallId, input });
  const prefix = data.length > MAX_TOOL_DATA_BYTES
    ? JSON.stringify({ toolName, toolCallId, input: slimInput(toolName, input) })
    : data;
  return `HOY_TOOL_DATA:${prefix}\n${label}`;
}

// Truncate content fields to keep the serialized prefix under MAX_TOOL_DATA_BYTES.
function slimInput(toolName: string, input: any): any {
  if (toolName === "edit" && Array.isArray(input?.edits)) {
    return {
      ...input,
      edits: input.edits.map((e: any) => ({
        oldText: e.oldText.length > 400 ? `${e.oldText.slice(0, 397)}...` : e.oldText,
        newText: e.newText.length > 400 ? `${e.newText.slice(0, 397)}...` : e.newText,
      })),
    };
  }
  if (toolName === "write" && typeof input?.content === "string" && input.content.length > 1500) {
    return { ...input, content: `${input.content.slice(0, 1497)}...` };
  }
  return input;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
    // The child runs in the project dir, so process.cwd() is the project root
    // used to resolve the .hoy/plans plan-file gate (HOY-213).
    const cwd = process.cwd();
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
      const path = typeof (event.input as any)?.path === "string" ? (event.input as any).path : undefined;
      const decision = decide(mode, event.toolName, { path, cwd });
      if (decision === "allow") return undefined;
      if (decision === "block") {
        return { block: true, reason: blockReason(mode, event.toolName) };
      }
      if (sessionAllowed.has(event.toolName)) return undefined;

      const choice = await ctx.ui.select(describeToolCall(event.toolName, event.toolCallId, event.input), [
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
