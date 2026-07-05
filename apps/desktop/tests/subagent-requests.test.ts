import { describe, expect, test } from "bun:test";
import {
  recordSubagentRequest,
  takeSubagentRequest,
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
