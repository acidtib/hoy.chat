import { describe, expect, test } from "bun:test";
import { createHoyAgents, SPAWN_SYNC_PREFIX } from "./hoy-agents";
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

// Fake ctx mirroring hoy-mcp.test.ts's ctx: scripted select, captured input
// (the blocking spawn round-trip, HOY-300), project trust.
function ctx(
  opts: {
    select?: (title: string, options: string[]) => Promise<string>;
    trusted?: boolean;
    inputs?: string[];
    inputResult?: string | undefined;
  } = {},
) {
  const inputs = opts.inputs ?? [];
  const hasInputResult = "inputResult" in opts;
  return {
    ui: {
      select: opts.select ?? (async () => "Allow"),
      input: async (title: string) => {
        inputs.push(title);
        return hasInputResult ? opts.inputResult : "CHILD RESULT";
      },
      notify: () => {
        throw new Error("must not notify: spawning is synchronous now (HOY-300)");
      },
    },
    isProjectTrusted: () => opts.trusted ?? true,
  } as any;
}

describe("agent tool", () => {
  test("registers a tool named agent", () => {
    expect(mountAgentTool(builtinRegistry).name).toBe("agent");
  });

  test("agent tool blocks on ui.input and returns the child result in-band", async () => {
    let seenTitle = "";
    const c: any = {
      isProjectTrusted: () => true,
      ui: {
        input: async (title: string) => {
          seenTitle = title;
          return "CHILD RESULT";
        },
        notify: () => {
          throw new Error("must not notify: spawning is synchronous now");
        },
      },
    };
    const tool = mountAgentTool(builtinRegistry, false);
    const out = await tool.execute("id", { subagentType: "Explore", task: "look at X" }, undefined, undefined, c);
    expect(seenTitle.startsWith(SPAWN_SYNC_PREFIX)).toBe(true);
    const payload = JSON.parse(seenTitle.slice(SPAWN_SYNC_PREFIX.length));
    expect(payload.subagentType).toBe("Explore");
    expect(payload.task).toBe("look at X");
    expect(out.content[0].text).toBe("CHILD RESULT");
  });

  test("Allow blocks on ui.input with the payload and returns the child result", async () => {
    const tool = mountAgentTool(builtinRegistry);
    const inputs: string[] = [];
    const c = ctx({ inputs });
    const res = await tool.execute(
      "c1",
      { subagentType: "Explore", task: "read the README" },
      undefined,
      undefined,
      c,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0].startsWith(SPAWN_SYNC_PREFIX)).toBe(true);
    const payload = JSON.parse(inputs[0].slice(SPAWN_SYNC_PREFIX.length));
    expect(payload.subagentType).toBe("Explore");
    expect(payload.task).toBe("read the README");
    expect(typeof payload.agentId).toBe("string");
    expect(res.details.agentId).toBe(payload.agentId);
    expect(res.content[0].text).toBe("CHILD RESULT");
  });

  test("does not prompt when approval is not required (HOY-248 default off)", async () => {
    const tool = mountAgentTool(builtinRegistry, false);
    let asks = 0;
    const inputs: string[] = [];
    const c = ctx({
      select: async () => {
        asks++;
        return "Deny";
      },
      inputs,
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
    expect(inputs).toHaveLength(1);
    expect(inputs[0].startsWith(SPAWN_SYNC_PREFIX)).toBe(true);
    expect(typeof res.details.agentId).toBe("string");
  });

  test("Deny throws and never blocks on ui.input", async () => {
    const tool = mountAgentTool(builtinRegistry);
    const inputs: string[] = [];
    const c = ctx({ select: async () => "Deny", inputs });
    await expect(
      tool.execute("c2", { subagentType: "Explore", task: "x" }, undefined, undefined, c),
    ).rejects.toThrow(/declined/);
    expect(inputs).toHaveLength(0);
  });

  test("cancelled/aborted child (ui.input resolves undefined) returns a stopped-note, not the raw undefined", async () => {
    const tool = mountAgentTool(builtinRegistry, false);
    const c = ctx({ inputResult: undefined });
    const res = await tool.execute("c9", { subagentType: "Explore", task: "x" }, undefined, undefined, c);
    expect(res.content[0].text).toMatch(/stopped before returning a result/);
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
    expect(res.content[0].text).toBe("CHILD RESULT");
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
    expect(res.content[0].text).toBe("CHILD RESULT");
  });
});
