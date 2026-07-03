import { test, expect, beforeEach } from "bun:test";
import type { Project, Turn } from "../lib/types";
import {
  extractResultText,
  buildDelivery,
  queueDelivery,
  takeNextDelivery,
  pendingDeliveries,
  shouldDeliverToParent,
  shouldDeferUpDelivery,
  childThreadIdsOf,
  isSubagentThread,
  threadDepth,
  descendantThreadIdsOf,
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

test("shouldDeferUpDelivery: a leaf child (no outstanding children) never defers", () => {
  // Depth-1 behavior: an isSubagentThread with 0 outstanding delivers immediately.
  expect(shouldDeferUpDelivery({ parentThreadId: "p1" }, 0)).toBe(false);
  // Even a root with a stray count never defers (it has no parent to deliver to).
  expect(shouldDeferUpDelivery({ parentThreadId: null }, 3)).toBe(false);
  expect(shouldDeferUpDelivery({}, 3)).toBe(false);
});

test("shouldDeferUpDelivery: an intermediate agent with outstanding children defers", () => {
  const c = { parentThreadId: "root" };
  // One grandchild outstanding -> defer.
  expect(shouldDeferUpDelivery(c, 1)).toBe(true);
  // Two grandchildren outstanding -> still defer; only 0 clears it.
  expect(shouldDeferUpDelivery(c, 2)).toBe(true);
  // After both grandchildren applied (counter decremented to 0) -> delivers up.
  expect(shouldDeferUpDelivery(c, 0)).toBe(false);
});

test("deliver-once across depths: completedAt gates a re-deliver even once undeferred", () => {
  // After an intermediate agent finally delivers up, completedAt is stamped; a
  // further done (outstanding now 0, so no defer) must not re-deliver.
  const delivered = { parentThreadId: "root", completedAt: 999 };
  expect(shouldDeferUpDelivery(delivered, 0)).toBe(false);
  expect(shouldDeliverToParent(delivered)).toBe(false);
});

test("childThreadIdsOf: returns ids of threads whose parentThreadId matches", () => {
  const projects = [
    { id: "p", name: "p", path: null, threads: [
      { id: "parent", title: "", updatedAt: 0, sessionId: null },
      { id: "kidA", title: "", updatedAt: 0, sessionId: null, parentThreadId: "parent" },
      { id: "kidB", title: "", updatedAt: 0, sessionId: null, parentThreadId: "parent" },
      { id: "other", title: "", updatedAt: 0, sessionId: null, parentThreadId: "somethingElse" },
    ] },
  ] as any;
  expect(childThreadIdsOf(projects, "parent").sort()).toEqual(["kidA", "kidB"]);
  expect(childThreadIdsOf(projects, "parent-with-no-kids")).toEqual([]);
});

test("isSubagentThread is true when the thread has a parent", () => {
  expect(isSubagentThread({ parentThreadId: "t_parent" })).toBe(true);
});

test("isSubagentThread is false for a top-level thread", () => {
  expect(isSubagentThread({ parentThreadId: null })).toBe(false);
  expect(isSubagentThread({})).toBe(false);
});

test("childThreadIdsOf detects a parent's children", () => {
  const projects: Project[] = [
    {
      id: "p1",
      name: "p1",
      threads: [
        { id: "a", title: "a", updatedAt: 0, sessionId: null },
        { id: "b", title: "b", updatedAt: 0, sessionId: null, parentThreadId: "a" },
        { id: "c", title: "c", updatedAt: 0, sessionId: null },
      ],
    },
  ];
  expect(childThreadIdsOf(projects, "a")).toEqual(["b"]);
  expect(childThreadIdsOf(projects, "c")).toEqual([]);
});

// Depth-2 fixture for threadDepth / descendantThreadIdsOf: root r, child c
// (parent r), grandchild g (parent c), and an unrelated root u.
const projects: Project[] = [
  {
    id: "p1",
    name: "p1",
    threads: [
      { id: "r", title: "r", updatedAt: 0, sessionId: null },
      { id: "c", title: "c", updatedAt: 0, sessionId: null, parentThreadId: "r" },
      { id: "g", title: "g", updatedAt: 0, sessionId: null, parentThreadId: "c" },
      { id: "u", title: "u", updatedAt: 0, sessionId: null },
    ],
  },
];

test("threadDepth counts ancestors, root is 0", () => {
  expect(threadDepth(projects, "r")).toBe(0);
  expect(threadDepth(projects, "c")).toBe(1);
  expect(threadDepth(projects, "g")).toBe(2);
});

test("threadDepth returns 0 for an unknown id", () => {
  expect(threadDepth(projects, "nope")).toBe(0);
});

test("descendantThreadIdsOf walks the whole subtree", () => {
  expect(descendantThreadIdsOf(projects, "r").sort()).toEqual(["c", "g"]);
  expect(descendantThreadIdsOf(projects, "c")).toEqual(["g"]);
  expect(descendantThreadIdsOf(projects, "g")).toEqual([]);
});

test("descendantThreadIdsOf is cycle-guarded", () => {
  // A corrupt fixture where two threads point at each other as parents must
  // not throw or infinite-loop.
  const cyclic: Project[] = [
    {
      id: "p1",
      name: "p1",
      threads: [
        { id: "c", title: "c", updatedAt: 0, sessionId: null, parentThreadId: "g" },
        { id: "g", title: "g", updatedAt: 0, sessionId: null, parentThreadId: "c" },
      ],
    },
  ];
  expect(() => descendantThreadIdsOf(cyclic, "c")).not.toThrow();
});
