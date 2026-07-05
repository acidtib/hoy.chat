// Hoy's sidecar entry. Replaces the stock `pi --mode rpc` binary: we build the
// runtime ourselves so we can brand the agent (identity) and, later, inject a
// custom resource loader / in-process tools. The wire protocol is unchanged:
// runRpcMode speaks the exact JSONL RPC our Rust already drives (sidecar.rs).
//
// The prompt is a FULL replacement via systemPromptOverride (HOY-185). It
// restates pi's tool guidelines verbatim because a customPrompt replaces pi's
// default coding prompt entirely; see hoy-system-prompt.ts for the invariants
// that replacement freezes. OAuth is unaffected: the Claude Code identity edge
// lives in pi-ai's Anthropic provider, which injects system[0] itself for
// OAuth tokens and sends this prompt as system[1]. The earlier append-only
// route attributed that requirement to the wrong layer.

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createHoyPermissions, isPermissionMode, type PermissionMode } from "./hoy-permissions";
import { createHoyMcp, loadMcpConfig } from "./hoy-mcp";
import { createHoyAgents } from "./hoy-agents";
import { createHoyAskQuestion } from "./hoy-ask-question";
import { createHoyInit } from "./hoy-init";
import { createHoyTurnBudget } from "./hoy-turn-budget";
import { loadSubagentRegistry, enabledTypes, effectiveChildPrompt } from "./hoy-agents-registry";
import { buildHoySystemPrompt } from "./hoy-system-prompt";
import { runOAuthLogin } from "./hoy-oauth";
import { runGoalEval } from "./hoy-goal-eval";
import { runVerifyCommand } from "./hoy-verify-command";
import { runGoalAudit } from "./hoy-goal-audit";

// Permission gate (HOY-186): initial mode from Rust, default mode otherwise.
// The session registers the full built-in tool set so plan mode can explore
// with grep/find/ls while bash is blocked; the prompt's tools list matches.
const HOY_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp", "agent", "ask_question"];
const envMode = process.env.HOY_PERMISSION_MODE ?? "default";
const initialMode: PermissionMode = isPermissionMode(envMode) ? envMode : "default";

// Branded agent dir, set by Rust (pi_config::agent_dir, default ~/.hoy/agent).
// auth.json, models.json, and settings.json all resolve from here. HOY_-prefixed
// because the payload package.json sets piConfig.name="hoy", so Pi's own
// getAgentDir() derives and reads this same HOY_CODING_AGENT_DIR (HOY-261).
const agentDir = process.env.HOY_CODING_AGENT_DIR;
if (!agentDir) {
  console.error("hoy-sidecar: HOY_CODING_AGENT_DIR is required");
  process.exit(1);
}

// Set by Rust (create_session) only for spawned child sessions. Selects the
// child's built-in type; absent for user threads.
const subagentType = process.env.HOY_SUBAGENT_TYPE;

// Numeric depth from Rust (0 for root/user threads). A thread may spawn iff
// depth < MAX_SUBAGENT_DEPTH. Mirrors apps/desktop/src/state/limits.ts; keep
// the two in sync. This is the authoritative structural gate: a child at or
// beyond the cap never receives the agent tool, so it cannot spawn (HOY-245).
const subagentDepth = Number(process.env.HOY_SUBAGENT_DEPTH ?? 0);
const MAX_SUBAGENT_DEPTH = 3;
const canSpawn = subagentDepth < MAX_SUBAGENT_DEPTH;

// HOY-248: gate the `agent` tool's spawn on a per-type consent prompt only when
// Rust relays the renderer pref as HOY_REQUIRE_SUBAGENT_APPROVAL=1. Default off:
// spawns proceed without a prompt and the user watches/intervenes via FleetView.
const requireSubagentApproval = process.env.HOY_REQUIRE_SUBAGENT_APPROVAL === "1";

// OAuth login runs as its own short-lived invocation of this binary (Rust sets
// HOY_OAUTH_LOGIN=<providerId>). It speaks a different, one-shot JSONL protocol
// over stdio and exits; it never reaches runRpcMode below.
const oauthProvider = process.env.HOY_OAUTH_LOGIN;
if (oauthProvider) {
  await runOAuthLogin(agentDir, oauthProvider);
}

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
    inheritContext: t.inheritContext ?? false,
    maxTurns: t.maxTurns ?? null,
  }));
  process.stdout.write(JSON.stringify(defs));
  process.exit(0);
}

// Goal Mode (HOY-263): one-shot transcript evaluator. Rust spawns us with this
// env, captures the {met, reason} JSON on stdout, and exits us. Runs before the
// runtime is built so it never touches runRpcMode. Fail-open lives inside
// runGoalEval, which always writes JSON and exits.
if (process.env.HOY_GOAL_EVAL) {
  await runGoalEval(agentDir, process.cwd());
  // runGoalEval writes JSON to stdout and exits; this line is never reached.
}

// Goal Mode v2 (HOY-298): one-shot deterministic verify-command runner. Rust
// spawns us with this env, captures the {code, stdout, stderr, killed} JSON on
// stdout, and exits us. Runs before the runtime is built so it never touches
// runRpcMode. Fail-soft lives inside runVerifyCommand, which always writes JSON
// and exits 0 (a non-zero `code` means the gate failed).
if (process.env.HOY_VERIFY_COMMAND) {
  await runVerifyCommand();
  // runVerifyCommand writes JSON to stdout and exits; this line is never reached.
}

// Goal Mode v3 (HOY-299): one-shot READ-ONLY auditor. Rust spawns us with this
// env, captures the {met, reason} JSON on stdout, and exits us. Runs before the
// runtime is built so it never touches runRpcMode. Unlike the tool-less
// evaluator this is a genuine agentic loop over the Explore (read-only) toolset;
// runGoalAudit self-terminates via a turn budget plus an absolute wall-clock
// failsafe, and fails open to {met:false, ...}, always writing JSON and exiting 0.
if (process.env.HOY_GOAL_AUDIT) {
  await runGoalAudit(agentDir, process.cwd());
  // runGoalAudit writes JSON to stdout and exits; this line is never reached.
}

const factory: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  // MCP servers from the branded global + project mcp.json, merged per session
  // (project cwd wins). createHoyMcp registers the `mcp` proxy tool; with no
  // servers configured it simply reports none available (HOY-232).
  const mcpConfig = loadMcpConfig(agentDir, cwd);
  const registry = loadSubagentRegistry(agentDir, cwd);

  // Depth cap is absolute: if this child was spawned for a type that is no
  // longer in the freshly-loaded registry (its .hoy/agents/*.md was deleted or
  // renamed since the parent validated the spawn), fail closed. Falling through
  // to the parent branch would hand the child HOY_TOOLS (including agent) and
  // createHoyAgents, promoting it to a spawner. Phase 1's resolveSubagentType
  // threw here; preserve that.
  if (subagentType && !registry[subagentType]) {
    throw new Error(
      `hoy-sidecar: unknown subagent type "${subagentType}"; refusing to start child session (depth cap).`,
    );
  }

  const childType = subagentType ? registry[subagentType] : null;
  const baseTools = childType ? childType.tools : HOY_TOOLS;
  const tools = canSpawn && !baseTools.includes("agent") ? [...baseTools, "agent"] : baseTools;
  const advertised = enabledTypes(registry).map((t) => ({ name: t.name, description: t.description }));

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      noContextFiles: false,
      systemPromptOverride: () => {
        // Spawn guidance (agent tool + advertised types) is on iff this thread
        // can spawn, so a spawning-capable child sees it too. A non-spawning
        // child gets guidance off; effectiveChildPrompt still applies its body.
        const base = buildHoySystemPrompt(mcpConfig.servers.length > 0, canSpawn, advertised);
        return childType ? effectiveChildPrompt(childType, base) : base;
      },
      // Disk discovery of <agentDir>/{extensions,skills,prompts,themes} needs no
      // opt-in: DefaultResourceLoader.reload() auto-discovers user-scope resources
      // from agentDir unconditionally, and agentDir here is the branded
      // PI_CODING_AGENT_DIR Rust passes. Disk .ts extensions coexist with these
      // in-process extensionFactories. Proven against the bun --compile binary in
      // HOY-228 (jiti + typebox resolve via Pi's virtualModules; an extension's
      // own node_modules deps resolve from disk). See docs/plans/HOY-228-*.
      // createHoyAgents is the switch that installs the agent tool. It is added
      // iff this thread may spawn (depth < MAX_SUBAGENT_DEPTH), independent of
      // root-vs-child; a child at or beyond the cap never gets it.
      extensionFactories: [
        createHoyPermissions(initialMode),
        createHoyMcp(mcpConfig),
        // HOY-253: ask_question is a user-interaction tool, not a side
        // effect. Only root/user threads get it in their tool set (HOY_TOOLS);
        // child subagents (childType set) do not, since the intent-interrogation
        // phase belongs to the thread talking to the user, not a fire-and-forget
        // child. Registering it unconditionally is harmless (mirrors mcp): a
        // child never has it in `tools`, so it cannot call it.
        createHoyAskQuestion(),
        // HOY-265: /init generates or refreshes AGENTS.md. A user-invoked
        // command (surfaced via get_commands, HOY-223), so installing it
        // unconditionally is safe: a child subagent never types /init.
        createHoyInit(),
        ...(canSpawn ? [createHoyAgents(registry, requireSubagentApproval)] : []),
        // HOY-244: cap a budgeted subagent type's turns; root/unbudgeted threads
        // run uncapped. childType is null for user threads, so this is child-only.
        ...(childType?.maxTurns ? [createHoyTurnBudget(childType.maxTurns)] : []),
      ],
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    tools,
  });
  return { ...result, services, diagnostics: services.diagnostics };
};

// M4 persistence: open the thread's existing session when Rust passes its file
// (HOY_SESSION_FILE), else create a fresh one. create(cwd) resolves the session
// dir under PI_CODING_AGENT_DIR (~/.hoy/agent/sessions/<encoded-cwd>/), so
// transcripts stay in the branded dir. open() restores prior messages and keeps
// appending to the same file (stable identity across restart and respawn); fall
// back to a fresh session if the file is missing or unreadable.
const sessionFile = process.env.HOY_SESSION_FILE;
// HOY-244: on first spawn of a subagent whose type sets `inherit_context: true`,
// Rust passes the parent's transcript path here; forkFrom mints a fresh child
// session seeded with the parent's history so the child starts with full context.
// The renderer gates this (only sets the env for inheriting types), so honoring
// it unconditionally is correct. Absent, or on respawn (own HOY_SESSION_FILE set),
// this branch is skipped.
const inheritFrom = process.env.HOY_INHERIT_FROM_SESSION;
let sessionManager: SessionManager;
try {
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile);
  } else if (inheritFrom) {
    sessionManager = SessionManager.forkFrom(inheritFrom, process.cwd());
  } else {
    sessionManager = SessionManager.create(process.cwd());
  }
} catch (e) {
  console.error(`hoy-sidecar: could not open/fork session, starting fresh: ${e}`);
  sessionManager = SessionManager.create(process.cwd());
}

const runtime = await createAgentSessionRuntime(factory, {
  cwd: process.cwd(),
  agentDir,
  sessionManager,
});

await runRpcMode(runtime); // never returns
