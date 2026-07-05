import { test, expect } from "bun:test";
import type { Project, Turn } from "../lib/types";
import {
  extractResultText,
  childThreadIdsOf,
  isSubagentThread,
  threadDepth,
  descendantThreadIdsOf,
  threadHasRunningSubagents,
} from "./delivery";

const asst = (over: Partial<Extract<Turn, { role: "assistant" }>> = {}): Turn => ({
  role: "assistant",
  blocks: [],
  streaming: false,
  ...over,
});
const text = (content: string): Turn =>
  asst({ blocks: [{ kind: "text", content }] });

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

test("threadHasRunningSubagents: true only when a descendant is actually running (HOY-302)", () => {
  const projects = [
    { id: "p", name: "p", path: null, threads: [
      { id: "parent", title: "", updatedAt: 0, sessionId: null },
      { id: "kid", title: "", updatedAt: 0, sessionId: null, parentThreadId: "parent" },
      { id: "grandkid", title: "", updatedAt: 0, sessionId: null, parentThreadId: "kid" },
      { id: "lonely", title: "", updatedAt: 0, sessionId: null },
    ] },
  ] as any;
  const none = threadHasRunningSubagents(projects, {}, new Set(), [], "parent");
  expect(none).toBe(false);
  // A streaming direct child -> live fleet.
  expect(threadHasRunningSubagents(projects, { kid: true }, new Set(), [], "parent")).toBe(true);
  // A running transitive descendant (grandchild) also counts.
  expect(threadHasRunningSubagents(projects, {}, new Set(["grandkid"]), [], "parent")).toBe(true);
  // A queued descendant counts (waiting for a concurrency slot).
  expect(threadHasRunningSubagents(projects, {}, new Set(), ["kid"], "parent")).toBe(true);
  // A thread with no descendants is never a fleet, even if it is itself running.
  expect(threadHasRunningSubagents(projects, { lonely: true }, new Set(), [], "lonely")).toBe(false);
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
