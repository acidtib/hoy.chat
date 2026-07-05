import { test, expect } from "bun:test";
import { threadIconColorClass } from "./threadColor";

test("threadIconColorClass: teal only while a fleet is running (HOY-302)", () => {
  expect(threadIconColorClass({ hasRunningSubagents: true })).toBe("text-agent");
  // No running fleet -> neutral/muted, regardless of active/open (carried by the row).
  expect(threadIconColorClass({ hasRunningSubagents: false })).toBe(
    "text-muted-foreground",
  );
});
