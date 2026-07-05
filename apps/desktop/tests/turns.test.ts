import { describe, expect, test } from "bun:test";
import { applyEvent, messagesToTurns } from "@/lib/turns";
import type { Turn } from "@/lib/types";

function assistantTurn(turns: Turn[], index = 0) {
  const turn = turns[index];
  if (turn.role !== "assistant") throw new Error("expected assistant turn");
  return turn;
}

describe("messagesToTurns entry ids (HOY-304)", () => {
  test("stamps aligned entry ids onto the user turn and assistant blocks", () => {
    const turns = messagesToTurns(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "toolCall", id: "tc1", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      ["u1", "a1", "r1", "a2"],
    );

    // Two turns: user, then the merged assistant run (a1 + a2 fold together).
    const user = turns[0];
    if (user.role !== "user") throw new Error("expected user turn");
    expect(user.entryId).toBe("u1");

    const a = assistantTurn(turns, 1);
    // Turn anchors to the first assistant entry; blocks carry their own entry.
    expect(a.entryId).toBe("a1");
    expect(a.blocks[0]).toMatchObject({ kind: "text", content: "on it", entryId: "a1" });
    expect(a.blocks[1]).toMatchObject({ kind: "tool", entryId: "a1" });
    // The second assistant message's text is a distinct block with its own id.
    expect(a.blocks[2]).toMatchObject({ kind: "text", content: "done", entryId: "a2" });
  });

  test("omitting entry ids leaves turns and blocks unaddressed", () => {
    const turns = messagesToTurns([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ]);
    const user = turns[0];
    if (user.role !== "user") throw new Error("expected user turn");
    expect(user.entryId).toBeUndefined();
    const a = assistantTurn(turns, 1);
    expect(a.entryId).toBeUndefined();
    expect(a.blocks[0]).toMatchObject({ kind: "text", entryId: undefined });
  });
});

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
    // Pi transcripts carry no thinking duration (HOY-179).
    expect(a.reasoning?.seconds).toBeUndefined();
  });

  test("redacted (empty) thinking parts produce no reasoning block", () => {
    const turns = messagesToTurns([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    expect(assistantTurn(turns).reasoning).toBeUndefined();
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

describe("messagesToTurns images (HOY-205)", () => {
  test("collects image parts on a restored user message", () => {
    const turns = messagesToTurns([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    ]);

    const turn = turns[0];
    if (turn.role !== "user") throw new Error("expected user turn");
    expect(turn.text).toBe("describe");
    expect(turn.images).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  test("string content yields no images", () => {
    const turns = messagesToTurns([{ role: "user", content: "hi" }]);
    const turn = turns[0];
    if (turn.role !== "user") throw new Error("expected user turn");
    expect(turn.images).toBeUndefined();
  });

  test("image part without data mimeType defaults to image/png", () => {
    const turns = messagesToTurns([
      { role: "user", content: [{ type: "image", data: "BBBB" }] },
    ]);
    const turn = turns[0];
    if (turn.role !== "user") throw new Error("expected user turn");
    expect(turn.images?.[0].mimeType).toBe("image/png");
  });
});

describe("messagesToTurns context block (HOY-220)", () => {
  test("strips a leading inlined context block from restored user text", () => {
    const turns = messagesToTurns([
      {
        role: "user",
        content:
          '<context>\n<file path="a.ts">const a = 1;</file>\n</context>\n\nwhat does this do?',
      },
    ]);
    const turn = turns[0];
    if (turn.role !== "user") throw new Error("expected user turn");
    expect(turn.text).toBe("what does this do?");
  });

  test("leaves an ordinary message untouched", () => {
    const turns = messagesToTurns([
      { role: "user", content: "a normal message" },
    ]);
    const turn = turns[0];
    if (turn.role !== "user") throw new Error("expected user turn");
    expect(turn.text).toBe("a normal message");
  });
});

describe("applyEvent queueUpdate (HOY-218)", () => {
  test("queueUpdate is session-level and leaves the transcript unchanged", () => {
    const turns: Turn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", blocks: [], streaming: true },
    ];
    const next = applyEvent(turns, {
      kind: "queueUpdate",
      steering: ["later"],
      followUp: [],
    });
    expect(next).toEqual(turns);
  });
});
