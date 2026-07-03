import { test, expect } from "bun:test";
import type { AssistantBlock, Project, SessionStats, Turn } from "../lib/types";
import {
  fleetRoots,
  fleetMembers,
  fleetStatus,
  fleetRollup,
  fleetStatusCounts,
  currentTool,
} from "./fleet";

// Fixture tree: root r has two children c1 (leaf) and c2, and c2 has a
// grandchild g. u is a childless root (not a fleet). Shared by every test
// below unless a test needs its own shape.
const projects: Project[] = [
  {
    id: "p1",
    name: "p1",
    threads: [
      { id: "r", title: "r", updatedAt: 0 },
      { id: "c1", title: "c1", updatedAt: 0, parentThreadId: "r" },
      { id: "c2", title: "c2", updatedAt: 0, parentThreadId: "r" },
      { id: "g", title: "g", updatedAt: 0, parentThreadId: "c2" },
      { id: "u", title: "u", updatedAt: 0 },
    ],
  },
];

test("fleetRoots returns only root threads that have spawned a child", () => {
  const roots = fleetRoots(projects);
  // Excludes u (childless root) and c2 (has a child, g, but is itself not a root).
  expect(roots.map((t) => t.id)).toEqual(["r"]);
});

test("fleetMembers resolves the root and every descendant, root first", () => {
  const members = fleetMembers(projects, "r");
  expect(members.map((t) => t.id)).toEqual(["r", "c1", "c2", "g"]);
});

test("fleetMembers includes the grandchild", () => {
  const members = fleetMembers(projects, "r");
  expect(members.some((t) => t.id === "g")).toBe(true);
});

test("fleetMembers on an unresolvable root returns an empty list", () => {
  expect(fleetMembers(projects, "nope")).toEqual([]);
});

test("fleetStatus: running beats a stale error", () => {
  expect(fleetStatus("c1", { c1: true }, [], { c1: "boom" })).toBe("running");
});

test("fleetStatus: an error with no fresh run in flight is error", () => {
  expect(fleetStatus("c1", { c1: false }, [], { c1: "boom" })).toBe("error");
});

test("fleetStatus: error still outranks queued", () => {
  expect(fleetStatus("c1", {}, ["c1"], { c1: "boom" })).toBe("error");
});

test("fleetStatus: queued when waiting in the agent queue", () => {
  expect(fleetStatus("c1", {}, ["c1"], {})).toBe("queued");
});

test("fleetStatus: done is the resting state", () => {
  expect(fleetStatus("c1", {}, [], {})).toBe("done");
});

const mkStats = (total: number, cost: number): SessionStats => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  cost,
});

test("fleetRollup sums tokens and cost across members, skipping missing stats", () => {
  const stats: Record<string, SessionStats | null> = {
    a: mkStats(100, 0.5),
    b: null,
    c: mkStats(50, 0.25),
  };
  expect(fleetRollup(["a", "b", "c"], stats)).toEqual({ tokens: 150, cost: 0.75 });
});

test("fleetRollup returns 0/0 for an all-null set, not NaN", () => {
  expect(fleetRollup(["a", "b"], { a: null, b: null })).toEqual({ tokens: 0, cost: 0 });
});

test("fleetRollup returns 0/0 for an empty member list", () => {
  expect(fleetRollup([], {})).toEqual({ tokens: 0, cost: 0 });
});

test("fleetStatusCounts sums to memberIds.length", () => {
  const memberIds = ["r", "c1", "c2", "g"];
  const streaming = { c1: true };
  const agentQueue = ["c2"];
  const threadErrors = { g: "boom" };
  const counts = fleetStatusCounts(memberIds, streaming, agentQueue, threadErrors);
  expect(counts).toEqual({ running: 1, queued: 1, done: 1, error: 1 });
  expect(counts.running + counts.queued + counts.done + counts.error).toBe(memberIds.length);
});

const asst = (over: Partial<Extract<Turn, { role: "assistant" }>> = {}): Turn => ({
  role: "assistant",
  blocks: [],
  streaming: false,
  ...over,
});
const toolBlock = (name: string, running: boolean, title = ""): AssistantBlock => ({
  kind: "tool",
  tool: { id: name, name, title, output: "", running },
});

test("currentTool is null when there is no assistant turn", () => {
  expect(currentTool([{ role: "user", text: "go" }])).toBeNull();
});

test("currentTool is null when the last assistant turn is not streaming", () => {
  const turns: Turn[] = [asst({ streaming: false, blocks: [toolBlock("Read", true)] })];
  expect(currentTool(turns)).toBeNull();
});

test("currentTool is null when no tool block in the turn is running", () => {
  const turns: Turn[] = [
    asst({ streaming: true, blocks: [toolBlock("Read", false), toolBlock("Grep", false)] }),
  ];
  expect(currentTool(turns)).toBeNull();
});

test("currentTool picks the last running tool block among several", () => {
  const turns: Turn[] = [
    asst({
      streaming: true,
      blocks: [
        toolBlock("Read", false),
        toolBlock("Grep", true, "Searching"),
        { kind: "text", content: "..." },
        toolBlock("Edit", true, "Editing file.ts"),
      ],
    }),
  ];
  expect(currentTool(turns)).toBe("Editing file.ts");
});

test("currentTool falls back to the tool name when title is empty", () => {
  const turns: Turn[] = [asst({ streaming: true, blocks: [toolBlock("Bash", true, "")] })];
  expect(currentTool(turns)).toBe("Bash");
});

test("currentTool only looks at the last assistant turn", () => {
  const turns: Turn[] = [
    asst({ streaming: true, blocks: [toolBlock("Old", true, "Old tool")] }),
    { role: "user", text: "steer" },
    asst({ streaming: true, blocks: [toolBlock("New", true, "New tool")] }),
  ];
  expect(currentTool(turns)).toBe("New tool");
});
