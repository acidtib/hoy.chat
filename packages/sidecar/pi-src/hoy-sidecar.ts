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
import { createHoyAgents, resolveSubagentType } from "./hoy-agents";
import { buildHoySystemPrompt } from "./hoy-system-prompt";
import { runOAuthLogin } from "./hoy-oauth";

// Permission gate (HOY-186): initial mode from Rust, default mode otherwise.
// The session registers the full built-in tool set so plan mode can explore
// with grep/find/ls while bash is blocked; the prompt's tools list matches.
const HOY_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp", "agent"];
const envMode = process.env.HOY_PERMISSION_MODE ?? "default";
const initialMode: PermissionMode = isPermissionMode(envMode) ? envMode : "default";

// Branded agent dir, set by Rust (pi_config::agent_dir, default ~/.hoy/agent).
// auth.json, models.json, and settings.json all resolve from here.
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  console.error("hoy-sidecar: PI_CODING_AGENT_DIR is required");
  process.exit(1);
}

// Set by Rust (create_session) only for spawned child sessions. Selects the
// child's built-in type; absent for user threads. Depth cap: a child never gets
// the agent tool, so it cannot spawn (HOY-231).
const subagentType = process.env.HOY_SUBAGENT_TYPE;

// OAuth login runs as its own short-lived invocation of this binary (Rust sets
// HOY_OAUTH_LOGIN=<providerId>). It speaks a different, one-shot JSONL protocol
// over stdio and exits; it never reaches runRpcMode below.
const oauthProvider = process.env.HOY_OAUTH_LOGIN;
if (oauthProvider) {
  await runOAuthLogin(agentDir, oauthProvider);
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
  const childType = subagentType ? resolveSubagentType(subagentType) : null;
  const tools = childType ? childType.tools : HOY_TOOLS;

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      noContextFiles: false,
      systemPromptOverride: () =>
        childType?.systemPromptOverride ?? buildHoySystemPrompt(mcpConfig.servers.length > 0),
      // Disk discovery of <agentDir>/{extensions,skills,prompts,themes} needs no
      // opt-in: DefaultResourceLoader.reload() auto-discovers user-scope resources
      // from agentDir unconditionally, and agentDir here is the branded
      // PI_CODING_AGENT_DIR Rust passes. Disk .ts extensions coexist with these
      // in-process extensionFactories. Proven against the bun --compile binary in
      // HOY-228 (jiti + typebox resolve via Pi's virtualModules; an extension's
      // own node_modules deps resolve from disk). See docs/plans/HOY-228-*.
      // A child never gets createHoyAgents, so it cannot spawn (depth cap).
      extensionFactories: childType
        ? [createHoyPermissions(initialMode), createHoyMcp(mcpConfig)]
        : [createHoyPermissions(initialMode), createHoyMcp(mcpConfig), createHoyAgents()],
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
let sessionManager: SessionManager;
try {
  sessionManager = sessionFile
    ? SessionManager.open(sessionFile)
    : SessionManager.create(process.cwd());
} catch (e) {
  console.error(`hoy-sidecar: could not open ${sessionFile}, starting fresh: ${e}`);
  sessionManager = SessionManager.create(process.cwd());
}

const runtime = await createAgentSessionRuntime(factory, {
  cwd: process.cwd(),
  agentDir,
  sessionManager,
});

await runRpcMode(runtime); // never returns
