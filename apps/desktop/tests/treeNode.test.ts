import { describe, expect, test } from "bun:test";
import type { SessionEntry, SessionTreeNode } from "@/lib/types";
import {
  flattenTree,
  matchesFilter,
  messageFacet,
  nodeRoleLabel,
  type FlatNode,
} from "@/lib/treeNode";

describe("messageFacet (HOY-280 opaque-message peek)", () => {
  test("user message: string content, no tools", () => {
    const f = messageFacet({ role: "user", content: "Refactor the auth store" });
    expect(f).toEqual({
      role: "user",
      preview: "Refactor the auth store",
      hasToolCall: false,
      toolNames: [],
    });
  });

  test("tool-only assistant previews its tool names", () => {
    const f = messageFacet({
      role: "assistant",
      content: [
        { type: "toolCall", id: "1", name: "read", arguments: {} },
        { type: "toolCall", id: "2", name: "grep", arguments: {} },
      ],
    });
    expect(f.preview).toBe("read, grep");
    expect(f.toolNames).toEqual(["read", "grep"]);
    expect(f.hasToolCall).toBe(true);
  });

  test("assistant message: joins text blocks, first line only, detects tool call", () => {
    const f = messageFacet({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Moving onto the RPC.\nSecond line ignored." },
        { type: "toolCall", id: "tc1", name: "edit", arguments: {} },
      ],
    });
    expect(f.role).toBe("assistant");
    expect(f.preview).toBe("Moving onto the RPC.");
    expect(f.hasToolCall).toBe(true);
  });

  test("toolResult is not itself a tool call", () => {
    const f = messageFacet({ role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }] });
    expect(f.role).toBe("toolResult");
    expect(f.hasToolCall).toBe(false);
  });

  test("bashExecution previews its command", () => {
    expect(messageFacet({ role: "bashExecution", command: "bun test" }).preview).toBe("bun test");
  });

  test("unknown / empty payloads degrade safely", () => {
    expect(messageFacet(null)).toEqual({
      role: "unknown",
      preview: "",
      hasToolCall: false,
      toolNames: [],
    });
    expect(messageFacet({ role: "weird" }).role).toBe("unknown");
  });
});

// Tree fixtures. msg() builds a message entry; the tree nests children directly
// (pi pre-nests), so we assemble SessionTreeNode by hand.
function msg(id: string, parentId: string | null, role: string, extra: Record<string, unknown> = {}): SessionEntry {
  return { type: "message", id, parentId, timestamp: id, message: { role, ...extra } } as SessionEntry;
}
function node(entry: SessionEntry, children: SessionTreeNode[] = [], label?: string): SessionTreeNode {
  return { entry, children, label };
}

describe("flattenTree", () => {
  test("linear spine: all depth 0, leaf marked active, no branch points", () => {
    const tree = [
      node(msg("a", null, "user", { content: "one" }), [
        node(msg("b", "a", "assistant", { content: [{ type: "text", text: "two" }] }), [
          node(msg("c", "b", "user", { content: "three" })),
        ]),
      ]),
    ];
    const flat = flattenTree(tree, "c");
    expect(flat.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(flat.every((n) => n.depth === 0)).toBe(true);
    expect(flat.find((n) => n.id === "c")?.isActive).toBe(true);
    expect(flat.some((n) => n.isBranchPoint)).toBe(false);
  });

  test("branch point marks the fork and indents divergent children", () => {
    const tree = [
      node(msg("a", null, "user", { content: "root" }), [
        node(msg("b", "a", "user", { content: "left" })),
        node(msg("c", "a", "user", { content: "right" })),
      ]),
    ];
    const flat = flattenTree(tree, "b");
    expect(flat.find((n) => n.id === "a")?.isBranchPoint).toBe(true);
    // children of a branch point indent one level.
    expect(flat.find((n) => n.id === "b")?.depth).toBe(1);
    expect(flat.find((n) => n.id === "c")?.depth).toBe(1);
  });

  test("carries the resolved label from the node", () => {
    const flat = flattenTree([node(msg("a", null, "user", { content: "x" }), [], "refactor")], "a");
    expect(flat[0].label).toBe("refactor");
  });
});

describe("matchesFilter", () => {
  const mk = (over: Partial<FlatNode> & { entry: SessionEntry }): FlatNode => ({
    id: over.entry.id,
    depth: 0,
    isActive: false,
    isBranchPoint: false,
    hasChildren: false,
    message: over.entry.type === "message" ? messageFacet((over.entry as { message: unknown }).message) : undefined,
    ...over,
  });
  const user = mk({ entry: msg("u", null, "user", { content: "hi" }) });
  const tool = mk({ entry: msg("t", null, "toolResult", { content: [{ type: "text", text: "r" }] }) });
  const modelChange = mk({ entry: { type: "model_change", id: "m", parentId: null, timestamp: "m", provider: "p", modelId: "x" } as SessionEntry });
  const labeled = mk({ entry: msg("l", null, "assistant", { content: [{ type: "text", text: "z" }] }), label: "keep" });

  test("default hides model changes and tool results", () => {
    expect(matchesFilter(modelChange, "default")).toBe(false);
    expect(matchesFilter(tool, "default")).toBe(false);
    expect(matchesFilter(user, "default")).toBe(true);
  });
  test("no-tools hides tool results and tool-only assistant steps", () => {
    const toolOnly = mk({
      entry: msg("to", null, "assistant", {
        content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
      }),
    });
    expect(matchesFilter(tool, "no-tools")).toBe(false);
    expect(matchesFilter(toolOnly, "no-tools")).toBe(false);
    // no-tools is a strict subset of default, so meta stays hidden too
    expect(matchesFilter(modelChange, "no-tools")).toBe(false);
    // a prose assistant step survives no-tools even if it also called a tool
    expect(matchesFilter(labeled, "no-tools")).toBe(true);
  });
  test("user-only keeps user messages", () => {
    expect(matchesFilter(user, "user-only")).toBe(true);
    expect(matchesFilter(labeled, "user-only")).toBe(false);
  });
  test("labeled-only keeps labeled nodes", () => {
    expect(matchesFilter(labeled, "labeled-only")).toBe(true);
    expect(matchesFilter(user, "labeled-only")).toBe(false);
  });
  test("all shows everything; the active leaf is never hidden", () => {
    expect(matchesFilter(modelChange, "all")).toBe(true);
    expect(matchesFilter({ ...tool, isActive: true }, "user-only")).toBe(true);
  });
});

describe("nodeRoleLabel", () => {
  test("maps message roles and entry kinds to short labels", () => {
    const flat = flattenTree(
      [
        node(msg("a", null, "user", { content: "x" }), [
          node({ type: "compaction", id: "b", parentId: "a", timestamp: "b", summary: "s", firstKeptEntryId: "a", tokensBefore: 100 } as SessionEntry),
        ]),
      ],
      "a",
    );
    expect(nodeRoleLabel(flat[0])).toBe("you");
    expect(nodeRoleLabel(flat[1])).toBe("compacted");
  });
});
