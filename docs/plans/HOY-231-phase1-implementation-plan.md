# HOY-231 Phase 1: Subagent spawn channel + first-class child threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a running agent spawn a specialized child agent that appears as its own first-class thread nested under the parent, runs to completion in its own streaming transcript, and persists across restart.

**Architecture:** The parent's `agent` tool takes consent via `ctx.ui.select`, then fires a fire-and-forget `ctx.ui.notify` carrying a sentinel-prefixed JSON payload. Rust's `classify_extension_ui` detects the sentinel and emits a new `AgentEvent::SubagentSpawned` on the parent's channel instead of a notify. The renderer, on that event, creates a flat child `Thread` (linked by `parentThreadId`) and drives it through the existing `create_session` + `send_prompt` machinery; the sidebar derives the nesting. Fire-and-forget: no result returns to the parent in Phase 1 (that is Phase 2).

**Tech Stack:** Sidecar TypeScript (Pi extension API, TypeBox, bun test), Rust (Tauri v2, serde, cargo test), React/TS renderer (Zustand store, Tauri Channel).

Full design: `docs/plans/HOY-231-subagent-infrastructure-design.md`.

## Global Constraints

- No emojis anywhere (code, comments, docs, commits). No em-dashes; use a comma or semicolon.
- Code comments: facts/decisions/why only, no narration of what the code does.
- Commit messages: plain, `HOY-231:` prefix, no Co-Authored-By trailers.
- Pi is pinned at 0.80.3. Do not modify Pi; only the sanctioned `ctx.ui.*` push mechanisms are available to an extension during `runRpcMode`.
- The `AgentEvent` union in `apps/desktop/src-tauri/src/events.rs` and its mirror in `apps/desktop/src/lib/types.ts` MUST change together (header comment in both).
- Rebuild the sidecar binary (`packages/sidecar/build.sh`) after any `packages/sidecar/pi-src` change before live verification; a stale binary silently runs old code.
- The spawn sentinel string MUST be byte-identical in TS and Rust: `@hoy/spawn-subagent:`.
- Depth cap: a spawned child never gets the `agent` tool (children cannot spawn).

---

### Task 1: Sidecar `hoy-agents.ts` — built-in types + the `agent` tool

**Files:**
- Create: `packages/sidecar/pi-src/hoy-agents.ts`
- Create: `packages/sidecar/pi-src/hoy-agents.test.ts`

**Interfaces:**
- Produces: `SPAWN_NOTIFY_PREFIX: string`; `interface SubagentType { name: string; tools: string[]; systemPromptOverride?: string }`; `SUBAGENT_TYPES: Record<string, SubagentType>`; `resolveSubagentType(name: string): SubagentType`; `createHoyAgents(): (pi: ExtensionAPI) => void`.
- Consumes: `Type` from `"typebox"`; `ExtensionAPI`, `ExtensionContext` from `@earendil-works/pi-coding-agent`.

- [ ] **Step 1: Write the failing test** (`packages/sidecar/pi-src/hoy-agents.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import {
  createHoyAgents,
  resolveSubagentType,
  SUBAGENT_TYPES,
  SPAWN_NOTIFY_PREFIX,
} from "./hoy-agents";

// Fake ExtensionAPI: capture the registered tool.
function mount() {
  let tool: any;
  const pi: any = { registerTool: (t: any) => (tool = t), registerCommand: () => {}, on: () => {} };
  createHoyAgents()(pi);
  return tool;
}

// Fake ctx: scripted select + captured notify calls.
function ctx(select: (title: string, options: string[]) => Promise<string>) {
  const notifies: string[] = [];
  return {
    c: { ui: { select, notify: (m: string) => notifies.push(m) } } as any,
    notifies,
  };
}

describe("subagent types", () => {
  test("general-purpose has full tools minus agent (depth cap)", () => {
    const t = resolveSubagentType("general-purpose");
    expect(t.tools).toContain("bash");
    expect(t.tools).toContain("write");
    expect(t.tools).not.toContain("agent");
  });

  test("Explore is read-only and carries its own prompt", () => {
    const t = resolveSubagentType("Explore");
    expect(t.tools.sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(t.tools).not.toContain("bash");
    expect(t.systemPromptOverride).toBeDefined();
  });

  test("unknown type throws", () => {
    expect(() => resolveSubagentType("nope")).toThrow(/Unknown subagent type/);
  });
});

describe("agent tool", () => {
  test("registers a tool named agent", () => {
    expect(mount().name).toBe("agent");
  });

  test("Allow fires a sentinel notify with the payload and returns a handle", async () => {
    const tool = mount();
    const { c, notifies } = ctx(async () => "Allow");
    const res = await tool.execute("c1", { subagentType: "Explore", task: "read the README" }, undefined, undefined, c);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].startsWith(SPAWN_NOTIFY_PREFIX)).toBe(true);
    const payload = JSON.parse(notifies[0].slice(SPAWN_NOTIFY_PREFIX.length));
    expect(payload.subagentType).toBe("Explore");
    expect(payload.task).toBe("read the README");
    expect(typeof payload.agentId).toBe("string");
    expect(res.details.agentId).toBe(payload.agentId);
  });

  test("Deny throws and fires no notify", async () => {
    const tool = mount();
    const { c, notifies } = ctx(async () => "Deny");
    await expect(
      tool.execute("c2", { subagentType: "Explore", task: "x" }, undefined, undefined, c),
    ).rejects.toThrow(/declined/);
    expect(notifies).toHaveLength(0);
  });

  test("Allow for this session asks once, then not again", async () => {
    const tool = mount();
    let asks = 0;
    const c = { ui: { select: async () => { asks++; return "Allow for this session"; }, notify: () => {} } } as any;
    await tool.execute("c3", { subagentType: "general-purpose", task: "a" }, undefined, undefined, c);
    await tool.execute("c4", { subagentType: "general-purpose", task: "b" }, undefined, undefined, c);
    expect(asks).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents.test.ts`
Expected: FAIL, cannot resolve module `./hoy-agents`.

- [ ] **Step 3: Write the implementation** (`packages/sidecar/pi-src/hoy-agents.ts`)

```ts
// HOY-231 Phase 1: subagent support. The `agent` tool takes consent then fires a
// fire-and-forget sentinel notify; Rust turns it into AgentEvent::SubagentSpawned
// and the renderer spawns the child as its own thread. Fire-and-forget: no result
// returns to the parent in this phase. See docs/plans/HOY-231-*.

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
          text: `Spawned ${type.name} subagent (${agentId}). It runs in its own thread; its result does not return to you in this phase.`,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sidecar/pi-src && bun test hoy-agents.test.ts`
Expected: PASS (all cases in Task 1).

- [ ] **Step 5: Commit**

```bash
git add packages/sidecar/pi-src/hoy-agents.ts packages/sidecar/pi-src/hoy-agents.test.ts
git commit -m "HOY-231: agent tool + built-in subagent types (sidecar)"
```

---

### Task 2: Wire the `agent` tool into the sidecar entry + permission gate

**Files:**
- Modify: `packages/sidecar/pi-src/hoy-sidecar.ts` (line 23 imports, line 30 `HOY_TOOLS`, lines 50-84 factory, env reads near line 36)
- Modify: `packages/sidecar/pi-src/hoy-permissions.ts` (`decide()`, lines 32-41)
- Modify: `packages/sidecar/pi-src/hoy-permissions.test.ts` (add `agent` cases)

**Interfaces:**
- Consumes: `createHoyAgents`, `resolveSubagentType` from Task 1; existing `buildHoySystemPrompt`, `createHoyPermissions`, `createHoyMcp`, `loadMcpConfig`.
- Produces: a child sidecar that, when `HOY_SUBAGENT_TYPE` is set, runs with that type's tools + prompt and without the `agent` tool.

- [ ] **Step 1: Write the failing test** (add to `packages/sidecar/pi-src/hoy-permissions.test.ts`)

```ts
import { decide } from "./hoy-permissions";

describe("agent tool gating (HOY-231)", () => {
  test("allowed in default/acceptEdits (tool does its own consent)", () => {
    expect(decide("default", "agent")).toBe("allow");
    expect(decide("acceptEdits", "agent")).toBe("allow");
  });
  test("blocked in plan mode", () => {
    expect(decide("plan", "agent")).toBe("block");
  });
  test("allowed in autonomous", () => {
    expect(decide("autonomous", "agent")).toBe("allow");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sidecar/pi-src && bun test hoy-permissions.test.ts`
Expected: FAIL — `decide("default","agent")` returns `"ask"`, not `"allow"`.

- [ ] **Step 3a: Implement the `decide()` branch** (`hoy-permissions.ts`, function at lines 32-41)

Add the `agent` line after the plan-mode block and before the `MUTATING_TOOLS` line:

```ts
export function decide(mode: PermissionMode, toolName: string): GateDecision {
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (mode === "autonomous") return "allow";
  if (mode === "plan") {
    if (toolName === "write" || toolName === "mcp" || toolName === "bash") return "allow";
    return "block";
  }
  if (toolName === "agent") return "allow"; // consent lives in the agent tool (names type + task)
  if (MUTATING_TOOLS.has(toolName)) return mode === "acceptEdits" ? "allow" : "ask";
  return "ask"; // bash and unknown/custom tools in default and acceptEdits
}
```

(Plan mode returns `"block"` for `agent` via the plan branch, since `agent` is not write/mcp/bash. Autonomous returns `"allow"` earlier. The new line covers default/acceptEdits.)

- [ ] **Step 3b: Implement the entry wiring** (`hoy-sidecar.ts`)

Change the import at line 23 area and add the agents import:

```ts
import { createHoyMcp, loadMcpConfig } from "./hoy-mcp";
import { createHoyAgents, resolveSubagentType } from "./hoy-agents";
import { buildHoySystemPrompt } from "./hoy-system-prompt";
```

Add `"agent"` to `HOY_TOOLS` (line 30):

```ts
const HOY_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp", "agent"];
```

Read the subagent-type env near the other env reads (after line 36's `agentDir`):

```ts
// Set by Rust (create_session) only for spawned child sessions. Selects the
// child's built-in type; absent for user threads. Depth cap: a child never gets
// the agent tool, so it cannot spawn (HOY-231).
const subagentType = process.env.HOY_SUBAGENT_TYPE;
```

Replace the factory body (lines 50-84) so tools, extensions, and prompt depend on whether this is a child:

```ts
const factory: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sidecar/pi-src && bun test`
Expected: PASS — the new `agent` gating cases plus all existing sidecar tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sidecar/pi-src/hoy-sidecar.ts packages/sidecar/pi-src/hoy-permissions.ts packages/sidecar/pi-src/hoy-permissions.test.ts
git commit -m "HOY-231: register agent tool, gate it, apply child subagent type"
```

---

### Task 3: Rust `AgentEvent::SubagentSpawned` + sentinel classification

**Files:**
- Modify: `apps/desktop/src-tauri/src/events.rs` (`AgentEvent` enum, line 10)
- Modify: `apps/desktop/src-tauri/src/sidecar.rs` (`classify_extension_ui`, add a `SPAWN_NOTIFY_PREFIX` const; the `"notify"` arm)

**Interfaces:**
- Produces: `AgentEvent::SubagentSpawned { agent_id, subagent_type, task }` (serde tag `kind` = `"subagentSpawned"`, camelCase fields); a `notify` whose message starts with `SPAWN_NOTIFY_PREFIX` maps to it.

- [ ] **Step 1: Write the failing test** (add to `apps/desktop/src-tauri/src/sidecar.rs`, in the existing `#[cfg(test)] mod tests`)

```rust
#[test]
fn spawn_sentinel_notify_maps_to_subagent_spawned() {
    let payload = r#"{"agentId":"a1","subagentType":"Explore","task":"read the README"}"#;
    let value = serde_json::json!({
        "type": "extension_ui_request",
        "id": "u1",
        "method": "notify",
        "message": format!("{SPAWN_NOTIFY_PREFIX}{payload}"),
    });
    match classify_extension_ui("u1", "notify", &value) {
        ExtUiOutcome::Notify(AgentEvent::SubagentSpawned { agent_id, subagent_type, task }) => {
            assert_eq!(agent_id, "a1");
            assert_eq!(subagent_type, "Explore");
            assert_eq!(task, "read the README");
        }
        other => panic!("expected SubagentSpawned, got {other:?}"),
    }
}

#[test]
fn plain_notify_is_unchanged() {
    let value = serde_json::json!({
        "type": "extension_ui_request", "id": "u2", "method": "notify", "message": "hello",
    });
    match classify_extension_ui("u2", "notify", &value) {
        ExtUiOutcome::Notify(AgentEvent::Notify { message, .. }) => assert_eq!(message, "hello"),
        other => panic!("expected Notify, got {other:?}"),
    }
}
```

(If `ExtUiOutcome` does not already derive `Debug`, add `#[derive(Debug)]` to it so `panic!("{other:?}")` compiles.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test spawn_sentinel_notify_maps_to_subagent_spawned`
Expected: FAIL to compile — `AgentEvent::SubagentSpawned` and `SPAWN_NOTIFY_PREFIX` do not exist.

- [ ] **Step 3a: Add the event variant** (`events.rs`, inside the `AgentEvent` enum, near the other simple variants)

```rust
    /// A subagent spawn request surfaced from the parent's agent tool (HOY-231).
    /// The renderer creates a child thread and drives it; not a transcript event.
    SubagentSpawned {
        agent_id: String,
        subagent_type: String,
        task: String,
    },
```

- [ ] **Step 3b: Add the sentinel const + classification** (`sidecar.rs`)

Add near the top-level consts (by `EventSink`/`SessionId` at lines 23-27):

```rust
// Byte-identical to SPAWN_NOTIFY_PREFIX in hoy-agents.ts. A notify with this
// prefix is a spawn request, consumed here and never shown to the user (HOY-231).
const SPAWN_NOTIFY_PREFIX: &str = "@hoy/spawn-subagent:";
```

Replace the `"notify"` arm of `classify_extension_ui` with:

```rust
        "notify" => {
            let message = str_field("message").unwrap_or_default();
            match message
                .strip_prefix(SPAWN_NOTIFY_PREFIX)
                .and_then(|j| serde_json::from_str::<Value>(j).ok())
            {
                Some(p) => ExtUiOutcome::Notify(AgentEvent::SubagentSpawned {
                    agent_id: p.get("agentId").and_then(Value::as_str).unwrap_or_default().to_string(),
                    subagent_type: p.get("subagentType").and_then(Value::as_str).unwrap_or_default().to_string(),
                    task: p.get("task").and_then(Value::as_str).unwrap_or_default().to_string(),
                }),
                None => ExtUiOutcome::Notify(AgentEvent::Notify {
                    message,
                    notify_type: str_field("notifyType"),
                }),
            }
        }
```

(If the existing `"notify"` arm uses different field names for `AgentEvent::Notify`, keep those in the `None` branch. `ExtUiOutcome::Notify` is already routed to the parent's channel sink by `route_message`, so `SubagentSpawned` reaches the renderer with no `route_message` change.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS — both new tests plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/events.rs apps/desktop/src-tauri/src/sidecar.rs
git commit -m "HOY-231: SubagentSpawned event from sentinel notify (Rust)"
```

---

### Task 4: Rust `create_session` accepts subagent type + permission mode; spawn sets `HOY_SUBAGENT_TYPE`

**Files:**
- Modify: `apps/desktop/src-tauri/src/sidecar.rs` (`PiProcess::spawn` line 86; `spawn_session_in` line 787; `spawn_session` line 773; any other callers, e.g. `respawn`)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`create_session`, lines 267-278)

**Interfaces:**
- Consumes: nothing new.
- Produces: `create_session(cwd: String, session_file: Option<String>, subagent_type: Option<String>, permission_mode: Option<String>) -> Result<String, String>`. `spawn_session_in(&self, cwd, session_file, permission_mode, subagent_type)`. `PiProcess::spawn(..., permission_mode, subagent_type)`.

- [ ] **Step 1: Add the env var to `PiProcess::spawn`** (`sidecar.rs:86-114`)

Add a `subagent_type: Option<&str>` parameter after `permission_mode`, and set the env when present:

```rust
    fn spawn(
        bin: &Path,
        payload: &Path,
        agent_dir: &Path,
        cwd: &Path,
        session_file: Option<&str>,
        permission_mode: Option<&str>,
        subagent_type: Option<&str>,
    ) -> Result<Arc<PiProcess>, String> {
        // ... existing body ...
        if let Some(mode) = permission_mode {
            command.env("HOY_PERMISSION_MODE", mode);
        }
        if let Some(t) = subagent_type {
            command.env("HOY_SUBAGENT_TYPE", t);
        }
        // ... rest unchanged ...
    }
```

- [ ] **Step 2: Thread it through `spawn_session_in`** (`sidecar.rs:787-813`)

```rust
    pub fn spawn_session_in(
        &self,
        cwd: &Path,
        session_file: Option<&str>,
        permission_mode: Option<&str>,
        subagent_type: Option<&str>,
    ) -> Result<SessionId, String> {
        if !self.bin.exists() {
            return Err(format!(
                "sidecar binary not found at {}. Run sidecar/build.sh.",
                self.bin.display()
            ));
        }
        let proc = PiProcess::spawn(
            &self.bin,
            &self.payload,
            &self.agent_dir,
            cwd,
            session_file,
            permission_mode,
            subagent_type,
        )?;
        let id = format!("s{}", self.handle_counter.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().unwrap().insert(id.clone(), proc);
        self.cwds.lock().unwrap().insert(id.clone(), cwd.to_path_buf());
        Ok(id)
    }
```

- [ ] **Step 3: Fix the other call sites**

Update every remaining caller of `PiProcess::spawn` and `spawn_session_in` to pass the two new arguments, `None` for the existing behavior (user threads / boot / respawn keep their current mode handling). Callers to check: `spawn_session` (sidecar.rs:773), `respawn`, and any in `commands.rs`.

Run to find them:

```bash
cd apps/desktop/src-tauri && rg -n "spawn_session_in\(|PiProcess::spawn\(" src/
```

Expected: after edits, `cargo build` compiles with no missing-argument errors.

- [ ] **Step 4: Update the `create_session` command** (`commands.rs:267-278`)

```rust
#[tauri::command]
pub async fn create_session(
    cwd: String,
    session_file: Option<String>,
    subagent_type: Option<String>,
    permission_mode: Option<String>,
    manager: State<'_, SidecarManager>,
) -> Result<String, String> {
    let path = if cwd.trim().is_empty() {
        std::env::temp_dir()
    } else {
        PathBuf::from(cwd)
    };
    manager.spawn_session_in(&path, session_file.as_deref(), permission_mode.as_deref(), subagent_type.as_deref())
}
```

- [ ] **Step 5: Verify build + tests**

Run: `cd apps/desktop/src-tauri && cargo build && cargo test`
Expected: compiles clean; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/sidecar.rs apps/desktop/src-tauri/src/commands.rs
git commit -m "HOY-231: create_session takes subagent type + permission mode; spawn sets HOY_SUBAGENT_TYPE"
```

---

### Task 5: Persist `parentThreadId` + `spawnedBy` on `WsThread`

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs` (`WsThread` struct lines 39-60; add a `SpawnedBy` struct; the camelCase round-trip test near lines 199-209)

**Interfaces:**
- Produces: `WsThread.parent_thread_id: Option<String>` (JSON `parentThreadId`), `WsThread.spawned_by: Option<SpawnedBy>` (JSON `spawnedBy` = `{ type, agentId }`).

- [ ] **Step 1: Extend the round-trip test** (`workspace.rs` tests, near line 199)

```rust
#[test]
fn child_thread_fields_round_trip_camel_case() {
    let ws = Workspace {
        projects: vec![WsProject {
            id: "p1".into(),
            name: "P".into(),
            path: None,
            threads: vec![WsThread {
                id: "t2".into(),
                title: "child".into(),
                updated_at: 1,
                session_file: Some("f".into()),
                archived: false,
                renamed: false,
                draft: None,
                permission_mode: None,
                parent_thread_id: Some("t1".into()),
                spawned_by: Some(SpawnedBy { r#type: "Explore".into(), agent_id: "a1".into() }),
            }],
        }],
        active_project_id: None,
    };
    let json = serde_json::to_string(&ws).unwrap();
    assert!(json.contains("\"parentThreadId\":\"t1\""));
    assert!(json.contains("\"spawnedBy\""));
    assert!(json.contains("\"type\":\"Explore\""));
    assert!(json.contains("\"agentId\":\"a1\""));
    let back: Workspace = serde_json::from_str(&json).unwrap();
    assert_eq!(back.projects[0].threads[0].parent_thread_id.as_deref(), Some("t1"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test child_thread_fields_round_trip_camel_case`
Expected: FAIL to compile — fields and `SpawnedBy` do not exist.

- [ ] **Step 3: Implement** (`workspace.rs`)

Add the struct (after `WsThread`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedBy {
    pub r#type: String,
    pub agent_id: String,
}
```

Add the two fields to `WsThread` (both `#[serde(default)]`, camelCase handled by the struct's `rename_all`):

```rust
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    #[serde(default)]
    pub spawned_by: Option<SpawnedBy>,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/workspace.rs
git commit -m "HOY-231: persist parentThreadId + spawnedBy on threads (Rust)"
```

---

### Task 6: Renderer types + store orchestration of the child thread

**Files:**
- Modify: `apps/desktop/src/lib/types.ts` (`Thread` interface line 332; `AgentEvent` union lines 5-45)
- Modify: `apps/desktop/src/lib/ipc.ts` (the `createSession` wrapper — add the two new args)
- Modify: `apps/desktop/src/state/store.ts` (the per-turn channel wiring lines 1048-1093; `addThread`/`patchThread`; `persistProjects` allowlist lines 1709-1720; a new `spawnChildThread` action)

**Interfaces:**
- Consumes: `AgentEvent` (adds `subagentSpawned`), `Thread` (adds `parentThreadId`, `spawnedBy`), `createSession(cwd, sessionFile, subagentType, permissionMode)`.
- Produces: `spawnChildThread(parentThreadId: string, payload: { agentId: string; subagentType: string; task: string }): Promise<void>`; a reusable `streamPromptOnThread(threadId: string, sessionId: string, message: string)` extracted from `submitPrompt`.

- [ ] **Step 1: Add the types** (`types.ts`)

In the `AgentEvent` union (before `| { kind: "done" }`):

```ts
  | { kind: "subagentSpawned"; agentId: string; subagentType: string; task: string }
```

In the `Thread` interface (after `permissionMode`):

```ts
  // Set on a spawned child thread (HOY-231); null/absent on user threads. Kept
  // flat in project.threads; the sidebar derives nesting from this link.
  parentThreadId?: string | null;
  // The subagent type + parent handle that produced this child.
  spawnedBy?: { type: string; agentId: string } | null;
```

- [ ] **Step 2: Update the `createSession` IPC wrapper** (`ipc.ts`)

Extend the wrapper signature and `invoke` args to pass `subagentType` and `permissionMode` (snake_case keys `subagent_type`, `permission_mode` are mapped by Tauri from camelCase JS keys `subagentType`, `permissionMode`; match the existing convention in this file):

```ts
export function createSession(
  cwd: string,
  sessionFile: string | null,
  subagentType?: string | null,
  permissionMode?: string | null,
): Promise<string> {
  return invoke("create_session", {
    cwd,
    sessionFile,
    subagentType: subagentType ?? null,
    permissionMode: permissionMode ?? null,
  });
}
```

- [ ] **Step 3: Extract the channel wiring, handle the new event, and add the action** (`store.ts`)

3a. Extract the per-turn channel setup (currently inline in `submitPrompt`, store.ts:1048-1093) into a module helper so both `submitPrompt` and `spawnChildThread` use it. Move the `Channel` creation, `activeChannels.set`, the `onmessage` closure (including the `done`/`error`/`aborted` handling), and the `sendPrompt(...)` call into:

```ts
async function streamPromptOnThread(threadId: string, sessionId: string, message: string): Promise<void> {
  const channel = new Channel<AgentEvent>();
  activeChannels.set(threadId, channel);
  channel.onmessage = (event) => {
    if (activeChannels.get(threadId) !== channel) return;
    if (event.kind === "subagentSpawned") {
      void useSessionStore.getState().spawnChildThread(threadId, {
        agentId: event.agentId,
        subagentType: event.subagentType,
        task: event.task,
      });
      return;
    }
    // ... the existing body from store.ts:1053-1090 verbatim (applyEvent fold,
    // done -> activeChannels.delete + stopStreaming, error/aborted handling) ...
  };
  await sendPrompt(sessionId, message, channel);
}
```

Then in `submitPrompt`, replace the inlined block (1048-1093) with a call to `streamPromptOnThread(threadId, sessionId, outbound)` (preserve any image handling by keeping images in the helper signature if the current call passes them; add an optional `images` param mirroring the existing `sendPrompt` call).

3b. Add the store action (in the store creator, near `addThread` at store.ts:746):

```ts
  spawnChildThread: async (parentThreadId, payload) => {
    const found = findThread(get().projects, parentThreadId);
    if (!found) return;
    const { project, thread: parent } = found;
    const childId = newId("t");
    const shortTask = payload.task.length > 40 ? `${payload.task.slice(0, 40)}...` : payload.task;
    const child: Thread = {
      id: childId,
      title: `${payload.subagentType}: ${shortTask}`,
      updatedAt: Date.now(),
      sessionId: null,
      parentThreadId,
      spawnedBy: { type: payload.subagentType, agentId: payload.agentId },
    };
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, threads: [...p.threads, child] } : p,
      ),
    }));
    try {
      const cwd = project.path ?? "";
      const sessionId = await createSession(cwd, null, payload.subagentType, parent.permissionMode ?? null);
      set((s) => ({ projects: patchThread(s.projects, childId, (t) => ({ ...t, sessionId })) }));
      await streamPromptOnThread(childId, sessionId, payload.task);
    } catch (e) {
      set((s) => ({
        threadErrors: { ...s.threadErrors, [childId]: String(e instanceof Error ? e.message : e) },
      }));
    }
  },
```

Add `spawnChildThread` to the store's TypeScript interface (the `SessionStore`/state type) with signature `(parentThreadId: string, payload: { agentId: string; subagentType: string; task: string }) => Promise<void>`.

3c. Add the two fields to the `persistProjects` allowlist (store.ts:1711-1719), inside the `.map((t) => ({ ... }))`:

```ts
          parentThreadId: t.parentThreadId ?? null,
          spawnedBy: t.spawnedBy ?? null,
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/types.ts apps/desktop/src/lib/ipc.ts apps/desktop/src/state/store.ts
git commit -m "HOY-231: renderer spawns + drives child threads on subagentSpawned"
```

---

### Task 7: Sidebar nesting of child threads under their parent

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (`ProjectGroup` body lines 316-334; `ThreadRow` lines 339-443; the `filtered` projection lines 63-82)

**Interfaces:**
- Consumes: `Thread.parentThreadId`.
- Produces: nested, collapsed child rows under each parent thread.

- [ ] **Step 1: Render roots + nested children** (`ProjectGroup`, replace the `project.threads.map(...)` at lines 322-332)

Compute roots and children, and render each root followed by its (collapsed by default) children with a depth indent. Children default collapsed via local state keyed by parent id:

```tsx
{expanded && (
  <div className="mt-0.5 flex flex-col gap-0.5 pb-1">
    {project.threads.filter((t) => !t.parentThreadId).length === 0 ? (
      <p className="px-2.5 py-1 pl-7 text-xs text-muted-foreground">No threads yet</p>
    ) : (
      project.threads
        .filter((t) => !t.parentThreadId)
        .map((thread) => {
          const children = project.threads.filter((c) => c.parentThreadId === thread.id);
          const childrenOpen = openChildren.has(thread.id);
          return (
            <div key={thread.id}>
              <ThreadRow
                thread={thread}
                depth={0}
                active={thread.id === activeThreadId}
                open={openIds.has(thread.id)}
                onSelect={() => onSelectThread(thread.id)}
                childCount={children.length}
                childrenOpen={childrenOpen}
                onToggleChildren={() => toggleChildren(thread.id)}
              />
              {childrenOpen &&
                children.map((child) => (
                  <ThreadRow
                    key={child.id}
                    thread={child}
                    depth={1}
                    active={child.id === activeThreadId}
                    open={openIds.has(child.id)}
                    onSelect={() => onSelectThread(child.id)}
                  />
                ))}
            </div>
          );
        })
    )}
  </div>
)}
```

Add the collapse state at the top of `ProjectGroup`:

```tsx
const [openChildren, setOpenChildren] = useState<Set<string>>(new Set());
const toggleChildren = (id: string) =>
  setOpenChildren((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
```

- [ ] **Step 2: Give `ThreadRow` a depth indent + a child-toggle chevron** (lines 339-378)

Add `depth`, `childCount`, `childrenOpen`, `onToggleChildren` to the props, derive left padding from `depth`, and render a small chevron before the title when `childCount` is set. Replace the hardcoded `pl-3` with `depth > 0 ? "pl-9" : "pl-3"` (align children under the parent's title). Add, before the title span, when `childCount && childCount > 0`:

```tsx
<button
  type="button"
  aria-label={childrenOpen ? "Collapse subagents" : "Expand subagents"}
  onClick={(e) => { e.stopPropagation(); onToggleChildren?.(); }}
  className="shrink-0 text-muted-foreground hover:text-foreground"
>
  <ChevronRight className={cn("h-3 w-3 transition-transform", childrenOpen && "rotate-90")} />
</button>
```

(Import `ChevronRight` from `lucide-react` if not already imported. `spawnedBy` on a child can be surfaced as a small "subagent" affordance later; not required for Phase 1.)

- [ ] **Step 3: Keep the archived/search projection nesting-safe** (lines 63-82)

The `filtered` projection filters `p.threads` one level deep. Since children are flat in `p.threads`, the archived filter already includes them. Update the title-search filter so a child is kept when it OR its parent matches, and a parent is kept when it OR any child matches. In the search branch (lines 75-77), replace the per-thread predicate with:

```tsx
const matches = (t: Thread) => t.title.toLowerCase().includes(q);
const keep = (t: Thread) =>
  matches(t) ||
  (t.parentThreadId
    ? p.threads.some((pt) => pt.id === t.parentThreadId && matches(pt))
    : p.threads.some((c) => c.parentThreadId === t.id && matches(c)));
// use keep(t) where the old code used matches(t)
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "HOY-231: nest spawned child threads under their parent in the sidebar"
```

---

### Task 8: Rebuild, live-verify end to end, final commit

**Files:** none (build + verification).

- [ ] **Step 1: Rebuild the sidecar binary**

Run: `bash packages/sidecar/build.sh`
Expected: builds without error; asserts pass.

- [ ] **Step 2: Full test gate**

```bash
cd packages/sidecar/pi-src && bun test
cd apps/desktop/src-tauri && cargo test
cd apps/desktop && bunx tsc --noEmit
```

Expected: all green.

- [ ] **Step 3: Live-verify in the running app**

Run the app: `bun run tauri:dev`

In a thread, prompt: `Spawn an Explore subagent to summarize the top-level README.` Then verify, via the Tauri MCP bridge (screenshot each):
- The spawn consent card appears on the parent thread.
- On Allow, a child thread `Explore: ...` appears nested and collapsed under the parent.
- Expanding it shows the child's own streaming transcript running the task to completion (read-only tools only).
- The parent's `agent` tool call shows completed with the "Spawned ... subagent" text.
- Restart the app; the child thread is still present nested under the parent and reopens its transcript.

Capture screenshots for the ticket.

- [ ] **Step 4: Final commit + push**

```bash
git add -A
git commit -m "HOY-231: Phase 1 subagent spawn channel + first-class child threads"
git push origin main
```

Then set HOY-231 to Done with the verification evidence (test counts + screenshots) and file the Phase 2-5 follow-on tickets.

---

## Self-review

**Spec coverage:** design sections 1 (spawn trigger: Tasks 1-3), 2 (child-as-thread: Tasks 4-7), 3 (two built-ins: Task 1 + child-type application Task 2), 4 (safety: `decide()` branch Task 2, depth cap Tasks 1-2, consent Task 1), 6 checklist items 1-12 all map to Tasks 1-8. Deferred items (result delivery, steer, registry, panel) are correctly absent.

**Placeholder scan:** every code step contains full code; commands have expected output; no TBD/TODO. The two soft spots are inherent to renderer code I could not fully quote: Task 6 Step 3a ("the existing body from store.ts:1053-1090 verbatim") and Task 7's edits reference exact line ranges to modify rather than reproducing the entire surrounding component. These are line-anchored, not vague.

**Type consistency:** `SPAWN_NOTIFY_PREFIX` = `@hoy/spawn-subagent:` in both TS (Task 1) and Rust (Task 3). `subagentType`/`agentId`/`task` payload keys match across Task 1 (emit), Task 3 (parse), Task 6 (`spawnChildThread`). `create_session` param order `(cwd, session_file, subagent_type, permission_mode)` matches between Task 4 (Rust) and Task 6 (`createSession` wrapper: `cwd, sessionFile, subagentType, permissionMode`). `SubagentSpawned { agent_id, subagent_type, task }` (Rust, camelCase serde) mirrors `{ kind: "subagentSpawned"; agentId; subagentType; task }` (TS). `parentThreadId`/`spawnedBy` consistent across types.ts, persistProjects, and WsThread (`parent_thread_id`/`spawned_by`).
