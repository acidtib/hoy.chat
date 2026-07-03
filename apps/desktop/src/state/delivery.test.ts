import { test, expect, beforeEach } from "bun:test";
import type { Turn } from "../lib/types";
import {
  extractResultText,
  buildDelivery,
  queueDelivery,
  takeNextDelivery,
  pendingDeliveries,
  shouldDeliverToParent,
} from "./delivery";

const asst = (over: Partial<Extract<Turn, { role: "assistant" }>> = {}): Turn => ({
  role: "assistant",
  blocks: [],
  streaming: false,
  ...over,
});
const text = (content: string): Turn =>
  asst({ blocks: [{ kind: "text", content }] });

beforeEach(() => pendingDeliveries.clear());

test("extractResultText joins the final assistant text blocks", () => {
  const turns: Turn[] = [
    { role: "user", text: "go" },
    text("first"),
    { role: "user", text: "again" },
    asst({ blocks: [{ kind: "text", content: "the " }, { kind: "text", content: "answer" }] }),
  ];
  expect(extractResultText(turns)).toBe("the answer");
});

test("extractResultText reports an aborted child", () => {
  expect(extractResultText([text("partial"), asst({ aborted: true })])).toBe(
    "The subagent was stopped before finishing.",
  );
});

test("extractResultText reports a failed child", () => {
  expect(extractResultText([asst({ error: "boom" })])).toBe(
    "The subagent failed: boom",
  );
});

test("extractResultText handles empty output", () => {
  expect(extractResultText([{ role: "user", text: "go" }, asst()])).toBe(
    "(the subagent produced no output.)",
  );
});

test("buildDelivery frames the message with type and short id", () => {
  const d = buildDelivery("Explore", "abcdef1234567890", [text("found it")]);
  expect(d.subagentType).toBe("Explore");
  expect(d.agentId).toBe("abcdef1234567890");
  expect(d.message).toBe("[Subagent result -- Explore (abcdef12)]\n\nfound it");
});

test("queueDelivery / takeNextDelivery is FIFO per parent", () => {
  const a = buildDelivery("Explore", "a1111111", [text("A")]);
  const b = buildDelivery("Explore", "b2222222", [text("B")]);
  queueDelivery("p", a);
  queueDelivery("p", b);
  expect(takeNextDelivery("p")).toBe(a);
  expect(takeNextDelivery("p")).toBe(b);
  expect(takeNextDelivery("p")).toBeUndefined();
});

test("takeNextDelivery on an unknown parent is undefined", () => {
  expect(takeNextDelivery("nobody")).toBeUndefined();
});

test("shouldDeliverToParent: only a not-yet-completed child delivers", () => {
  expect(shouldDeliverToParent({ parentThreadId: "p1", completedAt: null })).toBe(true);
  expect(shouldDeliverToParent({ parentThreadId: "p1", completedAt: 123 })).toBe(false); // already delivered
  expect(shouldDeliverToParent({ parentThreadId: null, completedAt: null })).toBe(false); // not a child
  expect(shouldDeliverToParent({})).toBe(false);
});
