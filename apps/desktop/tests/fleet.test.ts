import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUN_MINUTES,
  costPerMinute,
  estimateMinutes,
  finishedRuns,
  forecast,
  haltingThread,
  moveQueued,
  openRuns,
} from "@/lib/fleet";
import { unassignedIssues } from "@/lib/delegate";
import type { FleetRun, LinearIssue, QueuedIssue, Thread } from "@/lib/types";

const MIN = 60_000;

function run(id: string, fleetRun: FleetRun, extra: Partial<Thread> = {}): Thread {
  return { id, title: id, updatedAt: 0, sessionId: null, agent: "Explore", fleetRun, ...extra };
}

const done = (minutes: number, extra: Partial<FleetRun> = {}): FleetRun => ({
  startedAt: 0,
  endedAt: minutes * MIN,
  outcome: "done",
  ...extra,
});

function issue(id: string): LinearIssue {
  return {
    id,
    identifier: `HOY-${id}`,
    title: id,
    description: null,
    url: "",
    priority: 3,
    priorityLabel: "Medium",
    estimate: null,
    stateName: "Todo",
    stateType: "unstarted",
    assignee: null,
    labels: [],
  };
}

const queued = (id: string, agent: string): QueuedIssue => ({
  agent,
  issue: issue(id),
  queuedAt: 0,
});

describe("estimateMinutes", () => {
  test("falls back to the default with no history", () => {
    expect(estimateMinutes([], 3)).toBe(DEFAULT_RUN_MINUTES);
  });

  test("uses the median run, or the per-point pace when the issue is pointed", () => {
    const history = finishedRuns(
      [
        run("a", done(10, { estimate: 1 })),
        run("b", done(30, { estimate: 3 })),
        run("c", done(50)),
      ],
      "Explore",
    );
    expect(estimateMinutes(history, null)).toBe(30);
    expect(estimateMinutes(history, 2)).toBe(20);
  });

  test("learns only from clean runs of that agent", () => {
    const threads = [
      run("a", done(10)),
      run("b", { ...done(99), outcome: "error" }),
      run("c", done(99), { agent: "Plan" }),
    ];
    expect(finishedRuns(threads, "Explore")).toHaveLength(1);
  });
});

test("costPerMinute divides total cost by total minutes, null without data", () => {
  expect(costPerMinute([])).toBeNull();
  const history = finishedRuns(
    [run("a", done(10, { cost: 0.5 })), run("b", done(30, { cost: 1.5 }))],
    "Explore",
  );
  expect(costPerMinute(history)).toBeCloseTo(0.05);
});

describe("haltingThread", () => {
  test("the latest unacknowledged failure halts the agent", () => {
    const failed = run("b", { startedAt: 0, endedAt: 2 * MIN, outcome: "stopped" });
    expect(haltingThread([run("a", done(1)), failed], "Explore")?.id).toBe("b");
  });

  test("a clean later run, Resume, or archiving clears it", () => {
    const failed = { startedAt: 0, endedAt: MIN, outcome: "error" as const };
    expect(haltingThread([run("a", failed), run("b", done(2))], "Explore")).toBeNull();
    expect(haltingThread([run("a", { ...failed, acknowledged: true })], "Explore")).toBeNull();
    expect(haltingThread([run("a", failed, { archived: true })], "Explore")).toBeNull();
  });

  test("open runs are running, not halting", () => {
    const threads = [run("a", { startedAt: 0 })];
    expect(haltingThread(threads, "Explore")).toBeNull();
    expect(openRuns(threads, "Explore").map((t) => t.id)).toEqual(["a"]);
  });
});

describe("forecast", () => {
  test("queued work waits for the running thread on one slot", () => {
    const f = forecast(10 * MIN, [{ startedAt: 0, minutes: 30 }], [15, 15], 1);
    expect(f.busyUntil).toBe(10 * MIN + 50 * MIN);
    expect(f.minutesLeft).toBe(50);
  });

  test("a second slot runs queued work alongside", () => {
    const f = forecast(0, [{ startedAt: 0, minutes: 30 }], [15, 15], 2);
    expect(f.busyUntil).toBe(30 * MIN);
  });

  test("an overrunning thread still counts a minute, an idle agent has no end", () => {
    expect(forecast(60 * MIN, [{ startedAt: 0, minutes: 10 }], [], 1).busyUntil).toBe(61 * MIN);
    expect(forecast(0, [], [], 1).busyUntil).toBeNull();
  });
});

test("moveQueued swaps within an agent's queue and skips other agents", () => {
  const q = [queued("1", "A"), queued("2", "B"), queued("3", "A")];
  expect(moveQueued(q, "3", -1).map((x) => x.issue.id)).toEqual(["3", "2", "1"]);
  expect(moveQueued(q, "1", -1)).toBe(q);
  expect(moveQueued(q, "2", 1)).toBe(q);
});

test("queued issues leave the Unassigned column", () => {
  const open = unassignedIssues([issue("1"), issue("2")], [], [queued("2", "A")]);
  expect(open.map((i) => i.id)).toEqual(["1"]);
});
