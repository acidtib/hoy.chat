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
