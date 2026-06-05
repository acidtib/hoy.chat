import { describe, expect, test } from "bun:test";
import { messagesToTurns } from "@/lib/turns";
import type { Turn } from "@/lib/types";

function assistantTurn(turns: Turn[], index = 0) {
  const turn = turns[index];
  if (turn.role !== "assistant") throw new Error("expected assistant turn");
  return turn;
}

describe("messagesToTurns reasoning", () => {
  test("thinking parts fold without inventing a zero duration", () => {
    const turns = messagesToTurns([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step one. " },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    const a = assistantTurn(turns, 1);
    expect(a.reasoning?.text).toBe("step one. ");
    // Pi transcripts carry no thinking duration; a synthetic 0 makes the UI
    // shimmer forever on finished blocks (HOY-179).
    expect(a.reasoning?.seconds).toBeUndefined();
  });

  test("consecutive thinking parts concatenate", () => {
    const turns = messagesToTurns([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a" },
          { type: "thinking", thinking: "b" },
        ],
      },
    ]);

    expect(assistantTurn(turns).reasoning?.text).toBe("ab");
  });
});
