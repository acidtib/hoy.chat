import { describe, expect, test } from "bun:test";
import {
  recordSubagentRequest,
  takeSubagentRequest,
  takeChildRequestsForParent,
  frameSubagentResult,
} from "@/state/subagent-requests";

test("record then take returns once, then undefined", () => {
  recordSubagentRequest("c1", { parentThreadId: "p1", parentSessionId: "s1", requestId: "r1" });
  expect(takeSubagentRequest("c1")?.requestId).toBe("r1");
  expect(takeSubagentRequest("c1")).toBeUndefined();
});

test("frameSubagentResult labels the result with the type", () => {
  const s = frameSubagentResult("Explore", "found it");
  expect(s).toContain("Explore");
  expect(s).toContain("found it");
});

test("takeChildRequestsForParent drops and returns only this parent's children", () => {
  // Parent ids are namespaced (rather than plain "p1"/"p2") because
  // subagentRequests is a module-level singleton shared across every test
  // file in this bun run; other suites (e.g. subagentSpawnSyncSlot.test.ts)
  // record entries under generic ids like "p1" and never clean them up.
  recordSubagentRequest("takeChildren-c1", {
    parentThreadId: "takeChildren-p1",
    parentSessionId: "s1",
    requestId: "r1",
  });
  recordSubagentRequest("takeChildren-c2", {
    parentThreadId: "takeChildren-p1",
    parentSessionId: "s1",
    requestId: "r2",
  });
  recordSubagentRequest("takeChildren-c3", {
    parentThreadId: "takeChildren-p2",
    parentSessionId: "s2",
    requestId: "r3",
  });

  const dropped = takeChildRequestsForParent("takeChildren-p1").sort();
  expect(dropped).toEqual(["takeChildren-c1", "takeChildren-c2"]);

  expect(takeSubagentRequest("takeChildren-c1")).toBeUndefined();
  expect(takeSubagentRequest("takeChildren-c2")).toBeUndefined();
  expect(takeSubagentRequest("takeChildren-c3")?.requestId).toBe("r3");
});
