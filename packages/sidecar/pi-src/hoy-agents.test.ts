import { describe, expect, test } from "bun:test";
import { createHoyAgents, SPAWN_NOTIFY_PREFIX } from "./hoy-agents";
import { BUILTIN_SUBAGENTS, type SubagentRegistry } from "./hoy-agents-registry";

function registryFrom(types: SubagentRegistry[string][]): SubagentRegistry {
  const reg: SubagentRegistry = {};
  for (const t of types) reg[t.name] = t;
  return reg;
}

const builtinRegistry: SubagentRegistry = registryFrom(BUILTIN_SUBAGENTS);

// Fake ExtensionAPI: capture the registered tool. requireApproval defaults to
// true here so the consent-gate tests below exercise the prompt; the default-off
// no-prompt behavior (HOY-248) gets its own test that passes false.
function mountAgentTool(registry: SubagentRegistry, requireApproval = true) {
  let tool: any;
  const pi: any = { registerTool: (t: any) => (tool = t), registerCommand: () => {}, on: () => {} };
  createHoyAgents(registry, requireApproval)(pi);
  return tool;
}

// Fake ctx mirroring hoy-mcp.test.ts's ctx: scripted select, captured notify, project trust.
function ctx(
  opts: {
    select?: (title: string, options: string[]) => Promise<string>;
    trusted?: boolean;
    notifies?: string[];
  } = {},
) {
  const notifies = opts.notifies ?? [];
  return {
    ui: { select: opts.select ?? (async () => "Allow"), notify: (m: string) => notifies.push(m) },
    isProjectTrusted: () => opts.trusted ?? true,
  } as any;
}

describe("agent tool", () => {
  test("registers a tool named agent", () => {
    expect(mountAgentTool(builtinRegistry).name).toBe("agent");
  });

  test("Allow fires a sentinel notify with the payload and returns a handle", async () => {
    const tool = mountAgentTool(builtinRegistry);
    const notifies: string[] = [];
    const c = ctx({ notifies });
    const res = await tool.execute(
      "c1",
      { subagentType: "Explore", task: "read the README" },
      undefined,
      undefined,
      c,
    );
    expect(notifies).toHaveLength(1);
    expect(notifies[0].startsWith(SPAWN_NOTIFY_PREFIX)).toBe(true);
    const payload = JSON.parse(notifies[0].slice(SPAWN_NOTIFY_PREFIX.length));
    expect(payload.subagentType).toBe("Explore");
    expect(payload.task).toBe("read the README");
    expect(typeof payload.agentId).toBe("string");
    expect(res.details.agentId).toBe(payload.agentId);
  });

  test("does not prompt when approval is not required (HOY-248 default off)", async () => {
    const tool = mountAgentTool(builtinRegistry, false);
    let asks = 0;
    const notifies: string[] = [];
    const c = ctx({
      select: async () => {
        asks++;
        return "Deny";
      },
      notifies,
    });
    const res = await tool.execute(
      "c0",
      { subagentType: "Explore", task: "read the README" },
      undefined,
      undefined,
      c,
    );
    // No consent prompt, and the spawn proceeds regardless of what select would return.
    expect(asks).toBe(0);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].startsWith(SPAWN_NOTIFY_PREFIX)).toBe(true);
    expect(typeof res.details.agentId).toBe("string");
  });

  test("Deny throws and fires no notify", async () => {
    const tool = mountAgentTool(builtinRegistry);
    const notifies: string[] = [];
    const c = ctx({ select: async () => "Deny", notifies });
    await expect(
      tool.execute("c2", { subagentType: "Explore", task: "x" }, undefined, undefined, c),
    ).rejects.toThrow(/declined/);
    expect(notifies).toHaveLength(0);
  });

  test("Allow for this session asks once, then not again", async () => {
    const tool = mountAgentTool(builtinRegistry);
    let asks = 0;
    const c = ctx({
      select: async () => {
        asks++;
        return "Allow for this session";
      },
    });
    await tool.execute("c3", { subagentType: "general-purpose", task: "a" }, undefined, undefined, c);
    await tool.execute("c4", { subagentType: "general-purpose", task: "b" }, undefined, undefined, c);
    expect(asks).toBe(1);
  });

  test("unknown type throws", async () => {
    const tool = mountAgentTool(builtinRegistry);
    await expect(
      tool.execute("c5", { subagentType: "nope", task: "x" }, undefined, undefined, ctx()),
    ).rejects.toThrow(/Unknown subagent type/);
  });

  test("a disabled type is rejected like an unknown one", async () => {
    const registry = {
      Off: { name: "Off", scope: "builtin", tools: ["read"], promptMode: "replace", enabled: false },
    } as any;
    const tool = mountAgentTool(registry);
    await expect(
      tool.execute("c6", { subagentType: "Off", task: "x" }, undefined, undefined, ctx()),
    ).rejects.toThrow(/Unknown subagent type/);
  });

  test("a global-scope type is not trust-gated when the project is untrusted", async () => {
    // Only project-scope types are gated on project trust; global (user agent
    // dir) types are the user's own and spawn regardless.
    const registry = {
      Glob: { name: "Glob", scope: "global", tools: ["read"], promptMode: "replace", enabled: true },
    } as any;
    const tool = mountAgentTool(registry);
    const untrusted = ctx({ trusted: false });
    const res = await tool.execute("c7", { subagentType: "Glob", task: "t" }, undefined, undefined, untrusted);
    expect(res.content[0].text).toContain("Spawned");
  });

  test("execute refuses a project-scoped type when the project is untrusted", async () => {
    const registry = {
      Explore: { name: "Explore", scope: "builtin", tools: ["read"], promptMode: "replace", enabled: true },
      Proj: { name: "Proj", scope: "project", tools: ["read"], promptMode: "replace", enabled: true },
    } as any;
    const tool = mountAgentTool(registry);
    const untrusted = ctx({ trusted: false });
    await expect(tool.execute("c1", { subagentType: "Proj", task: "t" }, undefined, undefined, untrusted)).rejects.toThrow(
      /not trusted/i,
    );
    // built-in still allowed under the same untrusted ctx
    const res = await tool.execute("c2", { subagentType: "Explore", task: "t" }, undefined, undefined, untrusted);
    expect(res.content[0].text).toContain("Spawned");
  });
});
