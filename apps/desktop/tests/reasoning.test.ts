import { describe, expect, test } from "bun:test";
import { applyEvent } from "@/lib/turns";
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
    expect(reasoningOf(turns)).toEqual({ text: "Let me think.", active: true });

    turns = apply(turns, { kind: "reasoning", phase: "end" });
    expect(reasoningOf(turns)).toEqual({ text: "Let me think.", active: false });
  });

  test("a delta with no prior start still opens the block", () => {
    const turns = apply(base(), {
      kind: "reasoning",
      phase: "delta",
      delta: "redacted",
    });
    expect(reasoningOf(turns)).toEqual({ text: "redacted", active: true });
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
});
