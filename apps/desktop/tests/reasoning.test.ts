import { describe, expect, test } from "bun:test";
import { applyEvent, markToolPending } from "@/lib/turns";
import type { AgentEvent, Turn } from "@/lib/types";

function base(): Turn[] {
  return [
    { role: "user", text: "hi" },
    { role: "assistant", blocks: [], streaming: true },
  ];
}

function reasoningOf(turns: Turn[]) {
  const last = turns[turns.length - 1];
  if (last.role !== "assistant") throw new Error("expected assistant turn");
  return last.reasoning;
}

function apply(turns: Turn[], ...events: AgentEvent[]): Turn[] {
  return events.reduce((acc, e) => applyEvent(acc, e), turns);
}

describe("applyEvent reasoning (HOY-211)", () => {
  test("folds start/delta/end into a single reasoning block", () => {
    let turns = apply(
      base(),
      { kind: "reasoning", phase: "start" },
      { kind: "reasoning", phase: "delta", delta: "Let me " },
      { kind: "reasoning", phase: "delta", delta: "think." },
    );
    expect(reasoningOf(turns)).toEqual({
      text: "Let me think.",
      active: true,
      blockIndex: 0,
    });

    turns = apply(turns, { kind: "reasoning", phase: "end" });
    expect(reasoningOf(turns)).toEqual({
      text: "Let me think.",
      active: false,
      blockIndex: 0,
    });
  });

  test("a delta with no prior start still opens the block", () => {
    const turns = apply(base(), {
      kind: "reasoning",
      phase: "delta",
      delta: "redacted",
    });
    expect(reasoningOf(turns)).toEqual({
      text: "redacted",
      active: true,
      blockIndex: 0,
    });
  });

  test("reasoning does not clobber text blocks", () => {
    const turns = apply(
      base(),
      { kind: "reasoning", phase: "start" },
      { kind: "reasoning", phase: "delta", delta: "hmm" },
      { kind: "text", delta: "answer" },
    );
    const last = turns[turns.length - 1];
    if (last.role !== "assistant") throw new Error("expected assistant turn");
    expect(last.reasoning?.text).toBe("hmm");
    expect(last.blocks).toEqual([{ kind: "text", content: "answer" }]);
  });

  test("moves the reasoning block below each tool while preserving later text", () => {
    const turns = apply(
      base(),
      { kind: "reasoning", phase: "delta", delta: "checking" },
      {
        kind: "tool",
        phase: "start",
        toolCallId: "read-1",
        toolName: "read",
      },
      { kind: "tool", phase: "end", toolCallId: "read-1", toolName: "read" },
      {
        kind: "tool",
        phase: "start",
        toolCallId: "read-2",
        toolName: "read",
      },
      { kind: "reasoning", phase: "end" },
      { kind: "text", delta: "done" },
    );

    const last = turns[turns.length - 1];
    if (last.role !== "assistant") throw new Error("expected assistant turn");
    expect(last.reasoning).toMatchObject({ blockIndex: 2, active: false });
    expect(last.blocks).toHaveLength(3);
    expect(last.blocks[2]).toEqual({ kind: "text", content: "done" });
  });

  test("moves reasoning below a permission-pending tool inserted before start", () => {
    const turns = markToolPending(
      apply(base(), { kind: "reasoning", phase: "delta", delta: "checking" }),
      "edit-1",
      "edit",
      { path: "src/main.ts" },
    );

    const last = turns[turns.length - 1];
    if (last.role !== "assistant") throw new Error("expected assistant turn");
    expect(last.reasoning?.blockIndex).toBe(1);
    expect(last.blocks[0]).toMatchObject({
      kind: "tool",
      tool: { id: "edit-1", pending: true },
    });
  });
});
