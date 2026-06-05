// Hoy's sidecar entry. Replaces the stock `pi --mode rpc` binary: we build the
// runtime ourselves so we can brand the agent (identity) and, later, inject a
// custom resource loader / in-process tools. The wire protocol is unchanged:
// runRpcMode speaks the exact JSONL RPC our Rust already drives (sidecar.rs).
//
// Branding lives in appendSystemPromptOverride, NOT systemPromptOverride. In pi
// 0.78.0 a customPrompt (the systemPromptOverride result) REPLACES the default
// coding-agent system prompt (core/system-prompt.js), which would strip Pi's
// tool-use guidelines. Appending keeps the full coding prompt and only adds a
// name, which is also what the OAuth identity edge requires (system[0] stays).

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const HOY_IDENTITY =
  "You are Hoy, a coding assistant. Your name is Hoy. When asked who you are or what your name is, always answer that you are Hoy.";

// Branded agent dir, set by Rust (pi_config::agent_dir, default ~/.hoy/agent).
// auth.json, models.json, and settings.json all resolve from here.
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  console.error("hoy-sidecar: PI_CODING_AGENT_DIR is required");
  process.exit(1);
}

const factory: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      noContextFiles: true, // replaces the stock --no-context-files flag
      appendSystemPromptOverride: (base) => [...base, HOY_IDENTITY],
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
  });
  return { ...result, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(factory, {
  cwd: process.cwd(),
  agentDir,
  sessionManager: SessionManager.inMemory(), // M1/M3 in-memory; M4 may persist
});

await runRpcMode(runtime); // never returns
