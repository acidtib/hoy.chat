import { describe, expect, test } from "bun:test";
import { createHoyLinear, LINEAR_PREFIX, LINEAR_TOOLS } from "./hoy-linear";

function mount() {
  const tools: Record<string, any> = {};
  const pi: any = {
    registerTool: (t: any) => (tools[t.name] = t),
    registerCommand: () => {},
    on: () => {},
  };
  createHoyLinear()(pi);
  return tools;
}

// Fake ctx whose ui.input records the request title and returns `answer`.
function ctx(answer: string | undefined) {
  const seen: string[] = [];
  return {
    ctx: { ui: { input: async (title: string) => (seen.push(title), answer) } } as any,
    seen,
  };
}

function payloadOf(title: string) {
  expect(title.startsWith(LINEAR_PREFIX)).toBe(true);
  return JSON.parse(title.slice(LINEAR_PREFIX.length));
}

describe("Linear tools", () => {
  test("registers every advertised tool", () => {
    expect(Object.keys(mount()).sort()).toEqual([...LINEAR_TOOLS].sort());
  });

  test("each tool sends its action through the Rust sentinel", async () => {
    const tools = mount();
    const ok = JSON.stringify({ ok: true, result: { identifier: "HOY-1" } });
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["linear_issue", { issue: "HOY-1" }, { action: "get", issue: "HOY-1" }],
      ["linear_comment", { issue: "HOY-1", body: "done" }, { action: "comment", issue: "HOY-1", body: "done" }],
      ["linear_set_state", { issue: "HOY-1", state: "done" }, { action: "set_state", issue: "HOY-1", state: "done" }],
      [
        "linear_create_issue",
        { title: "Follow up", issue: "HOY-1", relation: "sub_issue" },
        { action: "create", title: "Follow up", issue: "HOY-1", relation: "sub_issue" },
      ],
    ];
    for (const [name, params, expected] of cases) {
      const { ctx: c, seen } = ctx(ok);
      const result = await tools[name].execute("id", params, undefined, undefined, c);
      expect(payloadOf(seen[0])).toEqual(expected);
      expect(result.content[0].text).toContain("HOY-1");
    }
  });

  test("a Linear error becomes a tool error", async () => {
    const { ctx: c } = ctx(JSON.stringify({ ok: false, error: "Linear issue HOY-9 not found" }));
    await expect(
      mount().linear_issue.execute("id", { issue: "HOY-9" }, undefined, undefined, c),
    ).rejects.toThrow("HOY-9 not found");
  });

  test("a cancelled request is an error, not an empty success", async () => {
    const { ctx: c } = ctx(undefined);
    await expect(
      mount().linear_comment.execute("id", { issue: "HOY-1", body: "x" }, undefined, undefined, c),
    ).rejects.toThrow("cancelled");
  });

  test("the prefix matches what Rust intercepts", () => {
    expect(LINEAR_PREFIX).toBe("@hoy/linear:");
  });
});
